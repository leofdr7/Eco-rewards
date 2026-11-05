import { supabase } from './supabase';

export const FACE_MACHINE_CODE = 'ECO-48FM6V';
export const FACE_SAMPLES = 5;
export const FACE_BUCKET = 'face-inbox';

export type FaceRequestStatus = 'pending' | 'matched' | 'failed' | 'expired';
export type EnrollmentStatus = 'pending' | 'done' | 'failed';

export interface FaceRequestRow {
  id: string;
  machine_id: string;
  user_id: string;
  status: FaceRequestStatus;
  session_id: string | null;
  error: string | null;
  created_at: string;
  expires_at: string;
}

export interface EnrollmentJobRow {
  id: string;
  status: EnrollmentStatus;
  error: string | null;
  created_at: string;
}

export async function countFaceEmbeddings(userId: string) {
  const { count, error } = await supabase
    .from('face_embeddings')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function latestEnrollmentJob(userId: string) {
  const { data, error } = await supabase
    .from('face_enrollment_jobs')
    .select('id,status,error,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as EnrollmentJobRow | null) ?? null;
}

export async function deleteOwnFace(userId: string) {
  const { error: embeddingError } = await supabase
    .from('face_embeddings')
    .delete()
    .eq('user_id', userId);
  if (embeddingError) throw new Error(embeddingError.message);

  const { error: profileError } = await supabase
    .from('profiles')
    .update({ face_consent_at: null })
    .eq('id', userId);
  if (profileError) throw new Error(profileError.message);
}

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

export async function uploadEnrollment(userId: string, photos: Blob[]) {
  const jobId = newId();
  const paths: string[] = [];

  try {
    for (let index = 0; index < photos.length; index += 1) {
      const path = `${userId}/${jobId}-${index + 1}.jpg`;
      const { error } = await supabase.storage.from(FACE_BUCKET).upload(path, photos[index], {
        contentType: 'image/jpeg',
        upsert: false,
      });
      if (error) throw new Error(error.message);
      paths.push(path);
    }

    const { error } = await supabase.from('face_enrollment_jobs').insert({
      id: jobId,
      user_id: userId,
      status: 'pending',
      storage_paths: paths,
    });
    if (error) throw new Error(error.message);
    return jobId;
  } catch (error) {
    if (paths.length > 0) {
      await supabase.storage.from(FACE_BUCKET).remove(paths);
    }
    throw error;
  }
}

export async function findActiveMachine(machineCode: string) {
  const { data, error } = await supabase
    .from('machines')
    .select('id,machine_code,name')
    .eq('machine_code', machineCode)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

export async function createFaceRequest(machineId: string, userId: string) {
  const { error: deleteError } = await supabase
    .from('face_requests')
    .delete()
    .eq('user_id', userId)
    .eq('status', 'pending');
  if (deleteError) throw new Error(deleteError.message);

  const { data, error } = await supabase
    .from('face_requests')
    .insert({ machine_id: machineId, user_id: userId, status: 'pending' })
    .select('id,machine_id,user_id,status,session_id,error,created_at,expires_at')
    .single();

  if (error) throw new Error(error.message);
  return data as FaceRequestRow;
}
