// Supabase Edge Function: add-points
// Called by ESP32 to credit recycling points to a user.
//
// POST /functions/v1/add-points
// Body: {
//   "user_id"?: "<uuid>",
//   "account_number"?: "<digits>",
//   "session_id"?: "<uuid>",
//   "machine_code"?: "<code>",
//   "item_type": "bottle" | "can"
// }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const POINTS_MAP: Record<string, { points: number; description: string }> = {
  bottle: { points: 15, description: 'Bottle recycled (+15 pts)' },
  can: { points: 10, description: 'Can recycled (+10 pts)' },
};

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
    const { user_id, account_number, session_id, machine_code, item_type } = await req.json();

    if ((!user_id && !account_number && !session_id) || !item_type) {
      return jsonResponse(
        { error: 'Missing account_number, user_id, or session_id, or item_type' },
        400
      );
    }

    const itemConfig = POINTS_MAP[item_type];
    if (!itemConfig) {
      return jsonResponse({ error: 'Invalid item_type. Must be "bottle" or "can"' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let session: {
      id: string;
      machine_id: string;
      user_id: string;
      status: string;
      expires_at: string;
      items_processed: number;
      machines?: { machine_code: string } | { machine_code: string }[];
    } | null = null;

    if (session_id) {
      const { data: sessionData, error: sessionError } = await supabase
        .from('recycling_sessions')
        .select(`
          id,
          machine_id,
          user_id,
          status,
          expires_at,
          items_processed,
          machines:machine_id (
            machine_code
          )
        `)
        .eq('id', session_id)
        .single();

      if (sessionError || !sessionData) {
        return jsonResponse({ error: 'Session not found' }, 404);
      }

      session = sessionData;
      const sessionMachine = Array.isArray(session.machines)
        ? session.machines[0]
        : session.machines;

      if (session.status !== 'armed' || new Date(session.expires_at).getTime() <= Date.now()) {
        if (session.status === 'armed') {
          await supabase
            .from('recycling_sessions')
            .update({ status: 'expired' })
            .eq('id', session.id);
        }
        return jsonResponse({ error: 'Session is not armed' }, 409);
      }

      if (machine_code && sessionMachine?.machine_code !== String(machine_code).trim().toUpperCase()) {
        return jsonResponse({ error: 'Session does not belong to this machine' }, 409);
      }
    }

    let profileQuery = supabase
      .from('profiles')
      .select('id, points_balance, monthly_eco_points, account_number');

    if (session) {
      profileQuery = profileQuery.eq('id', session.user_id);
    } else {
      profileQuery = account_number
        ? profileQuery.eq('account_number', account_number)
        : profileQuery.eq('id', user_id);
    }

    const { data: profile, error: profileError } = await profileQuery.single();

    if (profileError || !profile) {
      return jsonResponse({ error: 'User not found' }, 404);
    }

    if (session && account_number && profile.account_number !== String(account_number)) {
      return jsonResponse({ error: 'Session account mismatch' }, 409);
    }

    const { error: txError } = await supabase.from('transactions').insert({
      user_id: profile.id,
      type: item_type,
      points: itemConfig.points,
      description: itemConfig.description,
      machine_id: session?.machine_id ?? null,
      session_id: session?.id ?? null,
    });

    if (txError) {
      return jsonResponse({ error: 'Failed to create transaction' }, 500);
    }

    const newBalance = profile.points_balance + itemConfig.points;
    const newMonthlyEcoPoints = (profile.monthly_eco_points ?? 0) + itemConfig.points;
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        points_balance: newBalance,
        monthly_eco_points: newMonthlyEcoPoints,
      })
      .eq('id', profile.id);

    if (updateError) {
      return jsonResponse({ error: 'Failed to update balance' }, 500);
    }

    if (session) {
      await supabase
        .from('recycling_sessions')
        .update({
          items_processed: session.items_processed + 1,
          last_item_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        })
        .eq('id', session.id);
    }

    return jsonResponse({
      success: true,
      account_number: profile.account_number,
      user_id: profile.id,
      session_id: session?.id ?? null,
      machine_id: session?.machine_id ?? null,
      item_type,
      points_added: itemConfig.points,
      new_balance: newBalance,
      new_monthly_eco_points: newMonthlyEcoPoints,
    });
  } catch (_error) {
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
