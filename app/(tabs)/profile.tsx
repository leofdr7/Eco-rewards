import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '../../lib/AuthContext';
import { updateProfile, signOut, fetchCities } from '../../lib/auth';
import { fetchUserMedals } from '../../lib/ranking';
import CityPicker from '../../components/CityPicker';
import MedalBadge from '../../components/MedalBadge';
import { formatCompetitionMonth } from '../../constants/medals';
import { City, MonthlyUserResult } from '../../lib/database.types';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';

export default function ProfileScreen() {
  const router = useRouter();
  const { user, profile, refreshProfile } = useAuth();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [alias, setAlias] = useState(profile?.alias || '');
  const [fullName, setFullName] = useState(profile?.full_name || '');
  const [dateOfBirth, setDateOfBirth] = useState(
    profile?.date_of_birth
      ? new Date(profile.date_of_birth).toLocaleDateString('en-US')
      : ''
  );
  const [cityId, setCityId] = useState<string | null>(profile?.city_id ?? null);
  const [cities, setCities] = useState<City[]>([]);
  const [medals, setMedals] = useState<MonthlyUserResult[]>([]);

  useEffect(() => {
    fetchCities().then(setCities).catch(() => setCities([]));
  }, []);

  useEffect(() => {
    setCityId(profile?.city_id ?? null);
  }, [profile?.city_id]);

  useEffect(() => {
    if (!user) return;
    fetchUserMedals(user.id).then(setMedals).catch(() => setMedals([]));
  }, [user, profile?.monthly_eco_points]);

  const handleSave = async () => {
    setSaving(true);
    try {
      let formattedDob: string | null = null;
      let age: number | null = null;

      if (dateOfBirth) {
        const parts = dateOfBirth.split('/');
        if (parts.length === 3) {
          formattedDob = `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
          const birthDate = new Date(Number(parts[2]), Number(parts[0]) - 1, Number(parts[1]));
          const today = new Date();
          age = today.getFullYear() - birthDate.getFullYear();
          const m = today.getMonth() - birthDate.getMonth();
          if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
        }
      }

      await updateProfile(user!.id, {
        alias: alias.trim() || null,
        full_name: fullName.trim() || null,
        date_of_birth: formattedDob,
        age,
        city_id: cityId,
      });
      await refreshProfile();
      setEditing(false);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Could not update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          try {
            await signOut();
          } catch (error: any) {
            Alert.alert('Error', error.message);
          }
        },
      },
    ]);
  };

  const formatDateInput = (text: string) => {
    const cleaned = text.replace(/\D/g, '');
    let formatted = cleaned;
    if (cleaned.length > 2) {
      formatted = cleaned.slice(0, 2) + '/' + cleaned.slice(2);
    }
    if (cleaned.length > 4) {
      formatted = cleaned.slice(0, 2) + '/' + cleaned.slice(2, 4) + '/' + cleaned.slice(4, 8);
    }
    setDateOfBirth(formatted);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={styles.title}>Profile</Text>
          {!editing && (
            <TouchableOpacity
              style={styles.editButton}
              onPress={() => {
                setAlias(profile?.alias || '');
                setFullName(profile?.full_name || '');
                setDateOfBirth(
                  profile?.date_of_birth
                    ? new Date(profile.date_of_birth).toLocaleDateString('en-US')
                    : ''
                );
                setCityId(profile?.city_id ?? null);
                setEditing(true);
              }}
            >
              <Ionicons name="create-outline" size={20} color={Colors.primary} />
              <Text style={styles.editButtonText}>Edit</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.avatarSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(profile?.alias || profile?.full_name || profile?.email || 'U')[0].toUpperCase()}
            </Text>
          </View>
          <Text style={styles.displayName}>
            {profile?.alias || profile?.full_name || 'Recycler'}
          </Text>
          <Text style={styles.email}>{profile?.email || user?.email}</Text>
          <View style={styles.accountBadge}>
            <Ionicons name="keypad-outline" size={16} color={Colors.primary} />
            <Text style={styles.accountBadgeText}>
              Account #{profile?.account_number || 'Pending'}
            </Text>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{profile?.points_balance ?? 0}</Text>
              <Text style={styles.statLabel}>Points</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{profile?.monthly_eco_points ?? 0}</Text>
              <Text style={styles.statLabel}>Monthly</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>
                {profile?.date_of_birth
                  ? new Date(profile.date_of_birth).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })
                  : '-'}
              </Text>
              <Text style={styles.statLabel}>Birthday</Text>
            </View>
          </View>
        </View>

        {editing ? (
          <View style={styles.formCard}>
            <Text style={styles.formTitle}>Edit Profile</Text>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Alias / Username</Text>
              <View style={styles.inputContainer}>
                <TextInput
                  style={styles.input}
                  value={alias}
                  onChangeText={setAlias}
                  placeholder="Your alias"
                  placeholderTextColor={Colors.textLight}
                  autoCapitalize="none"
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Full Name</Text>
              <View style={styles.inputContainer}>
                <TextInput
                  style={styles.input}
                  value={fullName}
                  onChangeText={setFullName}
                  placeholder="Your full name"
                  placeholderTextColor={Colors.textLight}
                  autoCapitalize="words"
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Date of Birth</Text>
              <View style={styles.inputContainer}>
                <TextInput
                  style={styles.input}
                  value={dateOfBirth}
                  onChangeText={formatDateInput}
                  placeholder="MM/DD/YYYY"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="number-pad"
                  maxLength={10}
                />
              </View>
            </View>

            <CityPicker value={cityId} onChange={setCityId} />

            <View style={styles.formButtons}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setEditing(false)}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveButton, saving && styles.saveButtonDisabled]}
                onPress={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color={Colors.surface} size="small" />
                ) : (
                  <Text style={styles.saveButtonText}>Save Changes</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.infoCard}>
            <InfoRow icon="keypad-outline" label="Account Number" value={profile?.account_number || 'Pending'} />
            <InfoRow icon="at-outline" label="Alias" value={profile?.alias || 'Not set'} />
            <InfoRow icon="person-outline" label="Full Name" value={profile?.full_name || 'Not set'} />
            <InfoRow
              icon="location-outline"
              label="Department"
              value={cities.find((city) => city.id === profile?.city_id)?.name || 'Not set'}
            />
            <InfoRow
              icon="calendar-outline"
              label="Date of Birth"
              value={
                profile?.date_of_birth
                  ? new Date(profile.date_of_birth).toLocaleDateString('en-US', {
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                    })
                  : 'Not set'
              }
            />
            <InfoRow icon="mail-outline" label="Email" value={profile?.email || user?.email || ''} />
          </View>
        )}

        <View style={styles.medalsSection}>
          <Text style={styles.medalsTitle}>Monthly Medals</Text>
          {medals.length === 0 ? (
            <Text style={styles.medalsEmpty}>Recycle each month to earn Eco Oro, Plata, and Bronce medals.</Text>
          ) : (
            <View style={styles.medalsGrid}>
              {medals.map((medal) => {
                if (medal.medal_tier === 'none') return null;
                const competition = medal.monthly_competitions;
                return (
                  <MedalBadge
                    key={medal.id}
                    tier={medal.medal_tier}
                    size="sm"
                    subtitle={
                      competition
                        ? formatCompetitionMonth(competition.year, competition.month)
                        : undefined
                    }
                  />
                );
              })}
            </View>
          )}
        </View>

        <TouchableOpacity
          style={styles.faceButton}
          onPress={() => router.push('/face')}
          activeOpacity={0.8}
        >
          <Ionicons name="scan-outline" size={20} color={Colors.primaryDark} />
          <View style={styles.faceButtonText}>
            <Text style={styles.faceButtonTitle}>Registrar rostro</Text>
            <Text style={styles.faceButtonSubtitle}>
              {profile?.face_consent_at
                ? 'Hay un vector guardado. Puedes capturarlo de nuevo.'
                : 'Guarda tu rostro para activar la máquina.'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
        </TouchableOpacity>

        <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
          <Ionicons name="log-out-outline" size={20} color={Colors.error} />
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={infoStyles.row}>
      <View style={infoStyles.iconContainer}>
        <Ionicons name={icon} size={18} color={Colors.primary} />
      </View>
      <View style={infoStyles.content}>
        <Text style={infoStyles.label}>{label}</Text>
        <Text style={infoStyles.value}>{value}</Text>
      </View>
    </View>
  );
}

const infoStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    gap: Spacing.md,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: BorderRadius.sm,
    backgroundColor: Colors.primaryLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
  },
  label: {
    fontSize: FontSize.xs,
    color: Colors.textLight,
  },
  value: {
    fontSize: FontSize.md,
    color: Colors.text,
    fontWeight: '500',
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollContent: {
    padding: Spacing.lg,
    paddingBottom: Spacing.xxl,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: '800',
    color: Colors.text,
  },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.primaryLight,
  },
  editButtonText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    color: Colors.primary,
  },
  avatarSection: {
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  avatarText: {
    fontSize: FontSize.xxl,
    fontWeight: '800',
    color: Colors.surface,
  },
  displayName: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    color: Colors.text,
  },
  email: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  accountBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: Spacing.sm,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full,
  },
  accountBadgeText: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    color: Colors.primaryDark,
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: FontSize.xl,
    fontWeight: '800',
    color: Colors.primary,
  },
  statLabel: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 32,
    backgroundColor: Colors.border,
  },
  infoCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  formCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
    gap: Spacing.md,
  },
  formTitle: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    color: Colors.text,
  },
  fieldGroup: {
    gap: Spacing.xs,
  },
  label: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    color: Colors.text,
    marginLeft: Spacing.xs,
  },
  inputContainer: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    height: 48,
    justifyContent: 'center',
  },
  input: {
    fontSize: FontSize.md,
    color: Colors.text,
  },
  formButtons: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing.sm,
  },
  cancelButton: {
    flex: 1,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cancelButtonText: {
    fontSize: FontSize.md,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  saveButton: {
    flex: 1,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
  },
  saveButtonDisabled: {
    opacity: 0.7,
  },
  saveButtonText: {
    fontSize: FontSize.md,
    fontWeight: '700',
    color: Colors.surface,
  },
  medalsSection: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
    gap: Spacing.sm,
  },
  medalsTitle: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    color: Colors.text,
  },
  medalsEmpty: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  medalsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.md,
  },
  faceButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  faceButtonText: {
    flex: 1,
    gap: 2,
  },
  faceButtonTitle: {
    fontSize: FontSize.md,
    fontWeight: '700',
    color: Colors.text,
  },
  faceButtonSubtitle: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.error + '10',
    borderWidth: 1,
    borderColor: Colors.error + '30',
  },
  signOutText: {
    fontSize: FontSize.md,
    fontWeight: '600',
    color: Colors.error,
  },
});
