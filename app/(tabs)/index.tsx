import React, { useState, useEffect, useCallback } from 'react';
import {
  Alert,
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '../../lib/AuthContext';
import { supabase } from '../../lib/supabase';
import { fetchCityBattle } from '../../lib/ranking';
import { Transaction } from '../../lib/database.types';
import PointsCard from '../../components/PointsCard';
import TransactionItem from '../../components/TransactionItem';
import AccountNumberModal from '../../components/AccountNumberModal';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';
import {
  FACE_MACHINE_CODE,
  FaceRequestRow,
  countFaceEmbeddings,
  createFaceRequest,
  findActiveMachine,
} from '../../lib/faces';

export default function HomeScreen() {
  const router = useRouter();
  const { user, profile, refreshProfile } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showAccountNumber, setShowAccountNumber] = useState(false);
  const [faceRequest, setFaceRequest] = useState<FaceRequestRow | null>(null);
  const [armingFace, setArmingFace] = useState(false);
  const [stats, setStats] = useState({ bottles: 0, cans: 0 });
  const [cityBattleRank, setCityBattleRank] = useState<number | null>(null);

  const fetchTransactions = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);
    if (data) setTransactions(data);
  }, [user]);

  const fetchStats = useCallback(async () => {
    if (!user) return;
    const { data: bottleData } = await supabase
      .from('transactions')
      .select('id', { count: 'exact' })
      .eq('user_id', user.id)
      .eq('type', 'bottle');

    const { data: canData } = await supabase
      .from('transactions')
      .select('id', { count: 'exact' })
      .eq('user_id', user.id)
      .eq('type', 'can');

    setStats({
      bottles: bottleData?.length ?? 0,
      cans: canData?.length ?? 0,
    });
  }, [user]);

  const fetchCityRank = useCallback(async () => {
    if (!profile?.city_id) {
      setCityBattleRank(null);
      return;
    }
    try {
      const battle = await fetchCityBattle();
      const entry = battle.find((city) => city.city_id === profile.city_id);
      setCityBattleRank(entry?.rank ?? null);
    } catch {
      setCityBattleRank(null);
    }
  }, [profile?.city_id]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refreshProfile(), fetchTransactions(), fetchStats(), fetchCityRank()]);
    setRefreshing(false);
  }, [refreshProfile, fetchTransactions, fetchStats, fetchCityRank]);

  useEffect(() => {
    fetchTransactions();
    fetchStats();
    fetchCityRank();
  }, [fetchTransactions, fetchStats, fetchCityRank]);

  useEffect(() => {
    if (!faceRequest || faceRequest.status !== 'pending') return;

    const timer = setInterval(async () => {
      const { data } = await supabase
        .from('face_requests')
        .select('id,machine_id,user_id,status,session_id,error,created_at,expires_at')
        .eq('id', faceRequest.id)
        .single();
      if (!data) return;
      const next = data as FaceRequestRow;
      setFaceRequest(next);
      if (next.status === 'matched' && next.session_id) {
        router.push({
          pathname: '/session/[id]',
          params: { id: next.session_id },
        });
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [faceRequest, router]);

  const activateWithFace = async () => {
    if (!user || armingFace) return;
    setArmingFace(true);
    try {
      const samples = await countFaceEmbeddings(user.id);
      if (samples < 1) {
        Alert.alert(
          'Registra tu rostro',
          'En Perfil, captura tu rostro antes de activar la máquina.'
        );
        return;
      }
      const machine = await findActiveMachine(FACE_MACHINE_CODE);
      if (!machine) {
        Alert.alert(
          'Máquina no encontrada',
          `No hay una máquina activa ${FACE_MACHINE_CODE}.`
        );
        return;
      }
      const request = await createFaceRequest(machine.id, user.id);
      setFaceRequest(request);
    } catch (error: any) {
      Alert.alert('No se pudo pedir el reconocimiento', error.message || 'Inténtalo de nuevo.');
    } finally {
      setArmingFace(false);
    }
  };

  // Realtime subscription for live point updates
  useEffect(() => {
    if (!user) return;

    const channelTopic = `profile-changes-${user.id}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

    const channel = supabase
      .channel(channelTopic)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${user.id}`,
        },
        () => {
          refreshProfile();
          fetchTransactions();
          fetchStats();
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'transactions',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          refreshProfile();
          fetchTransactions();
          fetchStats();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchStats, fetchTransactions, refreshProfile, user]);

  const displayName = profile?.alias || profile?.full_name || 'Recycler';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.primary}
          />
        }
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.greeting}>Hello,</Text>
            <Text style={styles.name}>{displayName}</Text>
          </View>
          <TouchableOpacity
            style={styles.notifButton}
            onPress={() => setShowAccountNumber(true)}
          >
            <Ionicons name="keypad-outline" size={22} color={Colors.primary} />
          </TouchableOpacity>
        </View>

        <PointsCard
          points={profile?.points_balance ?? 0}
          bottlesCount={stats.bottles}
          cansCount={stats.cans}
        />

        {profile?.city_id && cityBattleRank ? (
          <TouchableOpacity
            style={styles.rankingTeaser}
            onPress={() => router.push('/(tabs)/ranking')}
            activeOpacity={0.85}
          >
            <View style={styles.rankingTeaserIcon}>
              <Ionicons name="trophy" size={18} color={Colors.accent} />
            </View>
            <View style={styles.rankingTeaserContent}>
              <Text style={styles.rankingTeaserTitle}>Monthly City Battle</Text>
              <Text style={styles.rankingTeaserText}>
                Your city is #{cityBattleRank} this month · {profile.monthly_eco_points ?? 0} eco-points
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={styles.recycleButton}
          onPress={() => router.push('/scan')}
          activeOpacity={0.8}
        >
          <View style={styles.recycleButtonInner}>
            <Ionicons name="qr-code" size={24} color={Colors.surface} />
            <Text style={styles.recycleButtonText}>Scan Machine QR</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.faceButton,
            (armingFace || faceRequest?.status === 'pending') && styles.faceButtonBusy,
          ]}
          onPress={activateWithFace}
          activeOpacity={0.8}
          disabled={armingFace || faceRequest?.status === 'pending'}
        >
          <Ionicons name="scan-outline" size={18} color={Colors.primaryDark} />
          <Text style={styles.fallbackButtonText}>
            {faceRequest?.status === 'pending'
              ? 'Mira a la cámara de la máquina…'
              : faceRequest?.status === 'failed' || faceRequest?.status === 'expired'
                ? 'Reintentar con mi rostro'
                : 'Activar con mi rostro'}
          </Text>
        </TouchableOpacity>
        {faceRequest && faceRequest.status !== 'pending' && faceRequest.status !== 'matched' ? (
          <Text style={styles.faceHint}>{faceRequest.error || 'No se reconoció el rostro.'}</Text>
        ) : null}

        <TouchableOpacity
          style={styles.fallbackButton}
          onPress={() => setShowAccountNumber(true)}
          activeOpacity={0.8}
        >
          <Ionicons name="keypad-outline" size={18} color={Colors.primary} />
          <Text style={styles.fallbackButtonText}>Use account number instead</Text>
        </TouchableOpacity>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent Activity</Text>
          {transactions.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="leaf-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyText}>No activity yet</Text>
              <Text style={styles.emptySubtext}>
                Start recycling to earn your first points!
              </Text>
            </View>
          ) : (
            <View style={styles.transactionsList}>
              {transactions.map((tx) => (
                <TransactionItem key={tx.id} transaction={tx} />
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {user && (
        <AccountNumberModal
          visible={showAccountNumber}
          accountNumber={profile?.account_number ?? null}
          onClose={() => setShowAccountNumber(false)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollContent: {
    paddingBottom: Spacing.xl,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
  },
  greeting: {
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },
  name: {
    fontSize: FontSize.xl,
    fontWeight: '800',
    color: Colors.text,
  },
  notifButton: {
    width: 48,
    height: 48,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.primaryLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rankingTeaser: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  rankingTeaserIcon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.accent + '20',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankingTeaserContent: {
    flex: 1,
    gap: 2,
  },
  rankingTeaserTitle: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    color: Colors.text,
  },
  rankingTeaserText: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  recycleButton: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.lg,
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  recycleButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  recycleButtonText: {
    color: Colors.surface,
    fontSize: FontSize.lg,
    fontWeight: '700',
  },
  faceButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.sm,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  faceButtonBusy: {
    opacity: 0.6,
  },
  faceHint: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.xs,
    textAlign: 'center',
    color: Colors.error,
    fontSize: FontSize.xs,
  },
  fallbackButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.sm,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primaryLight,
  },
  fallbackButtonText: {
    color: Colors.primaryDark,
    fontSize: FontSize.sm,
    fontWeight: '700',
  },
  section: {
    marginTop: Spacing.xl,
    paddingHorizontal: Spacing.lg,
  },
  sectionTitle: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: Spacing.md,
  },
  transactionsList: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: Spacing.xxl,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
  },
  emptyText: {
    fontSize: FontSize.md,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginTop: Spacing.md,
  },
  emptySubtext: {
    fontSize: FontSize.sm,
    color: Colors.textLight,
    marginTop: Spacing.xs,
  },
});
