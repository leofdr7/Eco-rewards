import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = req.method === 'GET'
      ? Object.fromEntries(new URL(req.url).searchParams.entries())
      : await req.json();
    const machineCode = String(body.machine_code || '').trim().toUpperCase();

    if (!machineCode) {
      return jsonResponse({ error: 'Missing machine_code' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: machine, error: machineError } = await supabase
      .from('machines')
      .select('id, machine_code, name')
      .eq('machine_code', machineCode)
      .eq('is_active', true)
      .single();

    if (machineError || !machine) {
      return jsonResponse({ armed: false, error: 'Machine not found or inactive' }, 404);
    }

    await supabase
      .from('recycling_sessions')
      .update({ status: 'expired' })
      .eq('machine_id', machine.id)
      .eq('status', 'armed')
      .lte('expires_at', new Date().toISOString());

    const { data: session, error: sessionError } = await supabase
      .from('recycling_sessions')
      .select(`
        id,
        expires_at,
        user_id,
        profiles:user_id (
          account_number,
          alias,
          full_name
        )
      `)
      .eq('machine_id', machine.id)
      .eq('status', 'armed')
      .gt('expires_at', new Date().toISOString())
      .order('armed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessionError) {
      return jsonResponse({ armed: false, error: 'Could not load session' }, 500);
    }

    if (!session) {
      return jsonResponse({
        armed: false,
        machine_id: machine.id,
        machine_code: machine.machine_code,
        machine_name: machine.name,
      });
    }

    const profile = Array.isArray(session.profiles)
      ? session.profiles[0]
      : session.profiles;

    return jsonResponse({
      armed: true,
      session_id: session.id,
      machine_id: machine.id,
      machine_code: machine.machine_code,
      machine_name: machine.name,
      user_id: session.user_id,
      account_number: profile?.account_number,
      display_name: profile?.alias || profile?.full_name || 'Recycler',
      expires_at: session.expires_at,
    });
  } catch (_error) {
    return jsonResponse({ armed: false, error: 'Internal server error' }, 500);
  }
});
