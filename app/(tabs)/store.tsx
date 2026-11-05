import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Modal,
  Alert,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../lib/AuthContext';
import { supabase } from '../../lib/supabase';
import { redeemReward } from '../../lib/auth';
import { Reward } from '../../lib/database.types';
import RewardItem from '../../components/RewardItem';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';

const CATEGORIES = [
  { key: 'all', label: 'All', icon: 'grid' as const },
  { key: 'coffee', label: 'Coffee', icon: 'cafe' as const },
  { key: 'food', label: 'Food', icon: 'fast-food' as const },
  { key: 'drinks', label: 'Drinks', icon: 'water' as const },
  { key: 'snacks', label: 'Snacks', icon: 'pizza' as const },
];

export default function StoreScreen() {
  const { user, profile, refreshProfile } = useAuth();
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [redemptionCode, setRedemptionCode] = useState<string | null>(null);

  const fetchRewards = useCallback(async () => {
    let query = supabase
      .from('rewards')
      .select('*')
      .eq('is_active', true)
      .order('points_cost', { ascending: true });

    if (selectedCategory !== 'all') {
      query = query.eq('category', selectedCategory);
    }

    const { data } = await query;
    if (data) setRewards(data);
  }, [selectedCategory]);

  useEffect(() => {
    fetchRewards();
  }, [fetchRewards]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchRewards(), refreshProfile()]);
    setRefreshing(false);
  }, [fetchRewards, refreshProfile]);

  const handleRedeem = (reward: Reward) => {
    Alert.alert(
      'Redeem Reward',
      `Are you sure you want to redeem "${reward.name}" for ${reward.points_cost} points?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Redeem',
          onPress: async () => {
            setRedeeming(true);
            try {
              const code = await redeemReward(user!.id, reward.id, reward.points_cost);
              setRedemptionCode(code);
              await refreshProfile();
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Could not redeem reward');
            } finally {
              setRedeeming(false);
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Rewards Store</Text>
        <View style={styles.balanceBadge}>
          <Ionicons name="leaf" size={16} color={Colors.primary} />
          <Text style={styles.balanceText}>{profile?.points_balance ?? 0}</Text>
        </View>
      </View>

      <View style={styles.categories}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={CATEGORIES}
          contentContainerStyle={styles.categoriesList}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                styles.categoryChip,
                selectedCategory === item.key && styles.categoryChipActive,
              ]}
              onPress={() => setSelectedCategory(item.key)}
            >
              <Ionicons
                name={item.icon}
                size={16}
                color={selectedCategory === item.key ? Colors.surface : Colors.textSecondary}
              />
              <Text
                style={[
                  styles.categoryText,
                  selectedCategory === item.key && styles.categoryTextActive,
                ]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          )}
        />
      </View>

      <FlatList
        data={rewards}
        numColumns={2}
        contentContainerStyle={styles.rewardsList}
        columnWrapperStyle={styles.rewardsRow}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.primary}
          />
        }
        renderItem={({ item }) => (
          <View style={styles.rewardCol}>
            <RewardItem
              reward={item}
              userPoints={profile?.points_balance ?? 0}
              onRedeem={handleRedeem}
            />
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="gift-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>No rewards available</Text>
          </View>
        }
      />

      {redeeming && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      )}

      <Modal
        visible={!!redemptionCode}
        transparent
        animationType="fade"
        onRequestClose={() => setRedemptionCode(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.successIcon}>
              <Ionicons name="checkmark-circle" size={64} color={Colors.success} />
            </View>
            <Text style={styles.modalTitle}>Reward Redeemed!</Text>
            <Text style={styles.modalSubtitle}>Show this code to claim your reward:</Text>
            <View style={styles.codeContainer}>
              <Text style={styles.codeText}>{redemptionCode}</Text>
            </View>
            <TouchableOpacity
              style={styles.modalButton}
              onPress={() => setRedemptionCode(null)}
            >
              <Text style={styles.modalButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: '800',
    color: Colors.text,
  },
  balanceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full,
  },
  balanceText: {
    fontSize: FontSize.md,
    fontWeight: '700',
    color: Colors.primary,
  },
  categories: {
    paddingVertical: Spacing.sm,
  },
  categoriesList: {
    paddingHorizontal: Spacing.lg,
    gap: Spacing.sm,
  },
  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  categoryChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  categoryText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  categoryTextActive: {
    color: Colors.surface,
  },
  rewardsList: {
    padding: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  rewardsRow: {
    gap: Spacing.md,
  },
  rewardCol: {
    flex: 1,
    marginBottom: Spacing.md,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: Spacing.xxl,
  },
  emptyText: {
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    marginTop: Spacing.md,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(255,255,255,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  modalContent: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    padding: Spacing.xl,
    alignItems: 'center',
    width: '100%',
    maxWidth: 340,
  },
  successIcon: {
    marginBottom: Spacing.md,
  },
  modalTitle: {
    fontSize: FontSize.xl,
    fontWeight: '800',
    color: Colors.text,
    marginBottom: Spacing.xs,
  },
  modalSubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.lg,
  },
  codeContainer: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xl,
    marginBottom: Spacing.lg,
    borderWidth: 2,
    borderColor: Colors.primary,
    borderStyle: 'dashed',
  },
  codeText: {
    fontSize: FontSize.xl,
    fontWeight: '800',
    color: Colors.primary,
    letterSpacing: 2,
  },
  modalButton: {
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xxl,
  },
  modalButtonText: {
    color: Colors.surface,
    fontSize: FontSize.md,
    fontWeight: '700',
  },
});
