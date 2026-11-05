import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../lib/AuthContext';
import {
  FACE_SAMPLES,
  countFaceEmbeddings,
  deleteOwnFace,
  latestEnrollmentJob,
  uploadEnrollment,
} from '../lib/faces';
import { BorderRadius, Colors, FontSize, Spacing } from '../constants/theme';

const POSES = [
  'Mira de frente',
  'Gira un poco a la izquierda',
  'Gira un poco a la derecha',
  'Sube un poco la barbilla',
  'Acércate un poco',
];

type Step = 'intro' | 'camera' | 'uploading' | 'waiting';

async function photoToJpeg(camera: CameraView) {
  const photo = await camera.takePictureAsync({
    quality: 0.7,
    base64: true,
    shutterSound: false,
  });
  if (!photo) throw new Error('La cámara no devolvió una foto.');

  if (photo.base64) {
    const binary = atob(photo.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: 'image/jpeg' });
  }

  if (photo.uri) {
    const response = await fetch(photo.uri);
    const buffer = await response.arrayBuffer();
    return new Blob([buffer], { type: 'image/jpeg' });
  }

  throw new Error('No se pudo leer la foto.');
}

export default function FaceEnrollScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [accepted, setAccepted] = useState(false);
  const [step, setStep] = useState<Step>('intro');
  const [samples, setSamples] = useState<Blob[]>([]);
  const [savedCount, setSavedCount] = useState(0);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    countFaceEmbeddings(user.id).then(setSavedCount).catch(() => setSavedCount(0));
  }, [user]);

  useEffect(() => {
    if (step !== 'waiting' || !user) return;
    const timer = setInterval(() => {
      latestEnrollmentJob(user.id)
        .then(async (job) => {
          if (!job) return;
          setJobStatus(job.status);
          setJobError(job.error);
          if (job.status === 'done') {
            const count = await countFaceEmbeddings(user.id);
            setSavedCount(count);
          }
        })
        .catch((error: Error) => setJobError(error.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [step, user]);

  const capture = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      const blob = await photoToJpeg(cameraRef.current);
      const next = [...samples, blob];
      setSamples(next);
      if (next.length >= FACE_SAMPLES && user) {
        setStep('uploading');
        await uploadEnrollment(user.id, next);
        setStep('waiting');
        setJobStatus('pending');
      }
    } catch (error: any) {
      Alert.alert('No se pudo capturar', error.message || 'Inténtalo de nuevo.');
      if (step === 'uploading') setStep('camera');
    } finally {
      setBusy(false);
    }
  };

  const removeFace = () => {
    if (!user) return;
    Alert.alert('Borrar rostro', 'Se eliminará el vector guardado en la base de datos.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Borrar',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteOwnFace(user.id);
            setSavedCount(0);
            setJobStatus(null);
          } catch (error: any) {
            Alert.alert('No se pudo borrar', error.message || 'Inténtalo de nuevo.');
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.iconButton} onPress={() => router.back()}>
          <Ionicons name="close" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Registrar rostro</Text>
        <View style={styles.iconButtonPlaceholder} />
      </View>

      {step === 'intro' ? (
        <View style={styles.card}>
          <Ionicons name="scan-outline" size={56} color={Colors.primary} />
          <Text style={styles.title}>Solo se guarda un vector</Text>
          <Text style={styles.message}>
            La app toma {FACE_SAMPLES} fotos. La simulación de la Jetson las lee, calcula el
            rostro con la GPU y borra las fotos. En la base queda un vector de 512 números,
            nunca la imagen.
          </Text>
          <Text style={styles.status}>
            {savedCount > 0 ? `Rostro registrado (${savedCount} muestras).` : 'Todavía no hay un rostro guardado.'}
          </Text>
          <TouchableOpacity
            style={styles.checkRow}
            onPress={() => setAccepted((value) => !value)}
            activeOpacity={0.8}
          >
            <Ionicons
              name={accepted ? 'checkbox' : 'square-outline'}
              size={22}
              color={Colors.primary}
            />
            <Text style={styles.checkText}>Acepto que EcoRewards guarde el vector de mi rostro.</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.primaryButton, !accepted && styles.primaryButtonDisabled]}
            disabled={!accepted}
            onPress={() => {
              if (!permission?.granted) {
                requestPermission();
              }
              setSamples([]);
              setStep('camera');
            }}
          >
            <Text style={styles.primaryButtonText}>Abrir cámara</Text>
          </TouchableOpacity>
          {savedCount > 0 ? (
            <TouchableOpacity onPress={removeFace}>
              <Text style={styles.link}>Borrar rostro</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {step === 'camera' || step === 'uploading' ? (
        <>
          {!permission?.granted ? (
            <View style={styles.card}>
              <Text style={styles.title}>Se necesita la cámara</Text>
              <Text style={styles.message}>Activa el permiso para capturar tu rostro.</Text>
              <TouchableOpacity style={styles.primaryButton} onPress={requestPermission}>
                <Text style={styles.primaryButtonText}>Permitir cámara</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={styles.cameraWrap}>
                <CameraView ref={cameraRef} style={styles.camera} facing="front" />
              </View>
              <View style={styles.footer}>
                {step === 'uploading' ? (
                  <>
                    <ActivityIndicator color={Colors.primary} />
                    <Text style={styles.title}>Subiendo fotos…</Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.title}>{POSES[samples.length] || POSES[POSES.length - 1]}</Text>
                    <Text style={styles.message}>
                      Foto {samples.length} de {FACE_SAMPLES}
                    </Text>
                    <TouchableOpacity
                      style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
                      onPress={capture}
                      disabled={busy}
                    >
                      <Text style={styles.primaryButtonText}>
                        {busy ? 'Capturando…' : 'Capturar'}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </>
          )}
        </>
      ) : null}

      {step === 'waiting' ? (
        <View style={styles.card}>
          <Ionicons
            name={jobStatus === 'done' ? 'checkmark-circle' : jobStatus === 'failed' ? 'alert-circle' : 'time-outline'}
            size={56}
            color={jobStatus === 'failed' ? Colors.error : Colors.primary}
          />
          <Text style={styles.title}>
            {jobStatus === 'done'
              ? 'Rostro guardado'
              : jobStatus === 'failed'
                ? 'No se pudo registrar'
                : 'Esperando a la máquina'}
          </Text>
          <Text style={styles.message}>
            {jobStatus === 'done'
              ? 'El vector ya está en Supabase. Puedes activar la máquina desde el inicio.'
              : jobStatus === 'failed'
                ? jobError || 'La máquina no pudo leer una cara en las fotos.'
                : 'Cuando first_contact.py esté corriendo, cargará las fotos en la GPU, guardará el vector y borrará las imágenes.'}
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={() => router.back()}>
            <Text style={styles.primaryButtonText}>Volver</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconButtonPlaceholder: {
    width: 44,
    height: 44,
  },
  headerTitle: {
    fontSize: FontSize.lg,
    fontWeight: '800',
    color: Colors.text,
  },
  card: {
    flex: 1,
    margin: Spacing.lg,
    borderRadius: BorderRadius.xl,
    backgroundColor: Colors.surface,
    padding: Spacing.xl,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.md,
  },
  cameraWrap: {
    flex: 1,
    marginHorizontal: Spacing.lg,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    backgroundColor: Colors.text,
  },
  camera: {
    flex: 1,
  },
  footer: {
    margin: Spacing.lg,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surface,
    padding: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: '800',
    color: Colors.text,
    textAlign: 'center',
  },
  message: {
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  status: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    color: Colors.primaryDark,
    textAlign: 'center',
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    alignSelf: 'stretch',
  },
  checkText: {
    flex: 1,
    fontSize: FontSize.sm,
    color: Colors.text,
    lineHeight: 20,
  },
  primaryButton: {
    alignSelf: 'stretch',
    marginTop: Spacing.sm,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    color: Colors.surface,
    fontSize: FontSize.md,
    fontWeight: '700',
  },
  link: {
    color: Colors.error,
    fontSize: FontSize.sm,
    fontWeight: '700',
  },
});
