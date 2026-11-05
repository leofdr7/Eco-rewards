# EcoRewards - Recycling Rewards App

A React Native (Expo) mobile app that rewards users with points for recycling bottles and cans. An ESP32 device detects the items and sends points to the user's account via Supabase.

## Points System

- **Bottle recycled:** +15 points
- **Can recycled:** +10 points
- **Rewards start at:** 200 points

## Tech Stack

- **Frontend:** React Native + Expo (TypeScript), Expo Router
- **Backend:** Supabase (Auth, PostgreSQL, Realtime, Edge Functions)
- **Hardware:** ESP32 controller + ESP32-CAM vision module

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Supabase

1. Create a new project at [supabase.com](https://supabase.com). The repository contains the schema and seed data, but it does not contain users, balances, transactions, or machine records from a previous Supabase project.
2. In the new project's SQL Editor, run these files **one at a time, in order**:
   - `supabase/migrations/001_create_tables.sql` - Creates tables, RLS, and triggers
   - `supabase/migrations/002_seed_rewards.sql` - Seeds reward options
   - `supabase/migrations/003_add_account_numbers.sql` - Adds unique numeric account numbers for keypad login on the machine
   - `supabase/migrations/004_machines_and_sessions.sql` - Adds machine QR codes, admin role, and QR-armed recycling sessions
   - `supabase/migrations/005_local_ranking.sql` - Adds cities, monthly rankings, and the monthly reset cron job
3. Enable the Email auth provider in Supabase Dashboard > Authentication > Providers.
4. Copy the new project URL and legacy `anon` key from Project Settings > API Keys. This code uses the legacy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` environment variables in its Edge Functions. Never put a `service_role` key in the app or ESP32.
5. From this repository, sign in with the included Supabase CLI, link the new project, and deploy the Edge Functions:

   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR_NEW_PROJECT_REF
   npx supabase functions deploy
   ```

### 3. Configure Environment

Create a `.env` file from the example if it does not already exist:

```bash
cp -n .env.example .env
```

Fill in your **new** Supabase project credentials:

```
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

### 4. Run the App

```bash
npx expo start
```

The mobile app uses Expo SDK 57. On a physical iPhone, sign in to the same Expo
account in Expo Go and the CLI (`npx expo login`). If the phone cannot reach the
computer over the local network, restart Metro with `npx expo start --tunnel`.

Register the first operator account in the app. Then promote that account in the new project's SQL Editor:

```sql
update public.profiles set role = 'admin' where email = 'operator@example.com';
```

Sign in again or refresh the app, open the Admin tab, register a new machine, and copy its generated `MACHINE_CODE` into the controller sketch.

### 5. ESP32 Setup

The project now supports a two-board hardware flow:

- `ArtificialVision/ArtificialVision.ino`: ESP32-CAM AI Thinker running the vision model.
- `esp32/vision_controller/vision_controller.ino`: controller ESP32 handling QR session polling, keypad fallback, LCD status, servo actuation, and Supabase calls.
- `esp32/uart_protocol.md`: UART wiring and message contract between both boards.

Open and upload each `.ino` from its own folder as a separate Arduino sketch. The camera sketch requires the exported Edge Impulse Arduino library that provides `Clasifier_inferencing.h`.

Before flashing, verify that the WiFi credentials, Supabase URL, legacy anon key, and `MACHINE_CODE` in the controller sketch match the active project and physical machine. `MACHINE_CODE` must match the code registered in `public.machines` and printed in the QR.

Arduino libraries used by the controller sketch:

- `Keypad`
- `ESP32Servo`
- `LiquidCrystal_I2C`

Machine flow:

1. An admin opens the Admin tab, registers a machine, prints its QR, and flashes the same `MACHINE_CODE` into the controller.
2. A user taps **Scan Machine QR** in the app and scans the QR on the physical machine.
3. The app calls `arm-session`, which validates the account and creates a 60-second armed session.
4. The controller polls `poll-session` with its `MACHINE_CODE` and arms itself when a session is waiting.
5. The ESP32-CAM detects `bottle` or `can` and sends `DETECT:bottle` or `DETECT:can` over UART.
6. The controller moves the servo and credits points through `add-points` with `session_id` and `machine_code`.
7. The app receives the updated balance and session item count through Supabase Realtime.
8. If QR scanning is unavailable, the user can still type the 6-digit account number on the keypad and press `#`.

### 6. Hardware Notes

- Share `GND` between the ESP32-CAM and the controller ESP32.
- Connect the ESP32-CAM UART `TX` pin to the controller ESP32 UART `RX` pin.
- Connect the LCD `SDA` to controller `GPIO21` and `SCL` to controller `GPIO22`.
- Connect the LCD `GND` to controller `GND` and `VCC` to the backpack-supported supply.
- Power the relay module from `5V` and `GND`, with the relay input connected to controller `GPIO23`.
- Keep controller `GND` and relay `GND` shared; do not connect `5V` directly to any ESP32 GPIO pin.
- The relay LED turns on when a QR session is armed or account entry starts, and turns off after completion, timeout, cancel, or invalid account validation.
- If the relay behavior is inverted, change `RELAY_ACTIVE_HIGH` in the controller sketch.
- If you later need retry-safe deduplication, extend `add-points` with a hardware-generated `event_id`.

### 7. LCD Status Flow

The `I2C LCD 1602` on the controller ESP32 shows short status messages such as:

- `Scan QR in app` / `Or enter acct #`
- `Account:` / typed digits
- `QR account valid` or `Account valid` / `Insert item`
- `Waiting item...` / `QR armed` or active account number
- `Detected:` / `Bottle` or `Can`
- `Sorting item` / `Please wait`
- `Bottle +15 pts` or `Can +10 pts`
- `Points failed` / `Retry item`

## Project Structure

```
app/
  (auth)/           - Login, Register, Profile Setup screens
  (tabs)/           - Home, Rewards Store, History, Profile, Admin tabs
  scan.tsx          - Machine QR scanner
  session/[id].tsx  - Armed recycling session status
components/         - Reusable UI components
lib/                - Supabase client, auth helpers, types
constants/          - Theme colors, spacing, typography
supabase/
  migrations/       - SQL schema and seed data
  functions/        - Edge Functions (add-points, validate-account, arm-session, poll-session, monthly-reset)
esp32/              - Arduino sketch for ESP32
```
