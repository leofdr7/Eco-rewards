/*
 * ESP32 Vision Controller - EcoRewards recycling machine controller
 *
 * Target board: ESP32 Dev Module
 * Arduino IDE: Board = ESP32 Dev Module
 *
 * Flow:
 * 1. User scans this machine's QR in the app, or enters a 6-digit account
 *    number on the keypad as a fallback.
 * 2. The controller polls Supabase for a QR-armed session or validates the
 *    keypad account.
 * 3. The ESP32-CAM sends `DETECT:bottle` or `DETECT:can` over UART.
 * 4. The controller runs the servo cycle once per accepted item.
 * 5. The controller credits reward points through the existing add-points function.
 *
 * Install libraries:
 * - Keypad by Mark Stanley / Alexander Brevig
 * - ESP32Servo by Kevin Harrington / John K. Bennett
 * - LiquidCrystal_I2C.h (included in this sketch folder)
 *
 * Replace WIFI_SSID, WIFI_PASSWORD, SUPABASE_URL, and SUPABASE_ANON_KEY
 * with your actual values before flashing.
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Keypad.h>
#include <ESP32Servo.h>
#include <HardwareSerial.h>
#include <Wire.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include "LiquidCrystal_I2C.h"

const char* WIFI_SSID = "iPhone de Leo";
const char* WIFI_PASSWORD = "flecha85espacial";
const char* SUPABASE_URL = "https://ocarmdddmhtrrnlmupge.supabase.co";
const char* SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jYXJtZGRkbWh0cnJubG11cGdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwODI2MjEsImV4cCI6MjEwNzY1ODYyMX0.CQ2D9S9sprjknn_PF_XQ4CuXlT9R9aXhhH8C6-Ar0kw";
const char* MACHINE_CODE = "ECO-48FM6V";

const byte ROWS = 4;
const byte COLS = 4;
// Key labels as seen from the front of the keypad, top to bottom.
char keys[ROWS][COLS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'}
};

// ESP32 Dev Module pinout (keypad rows/cols)
byte rowPins[ROWS] = {19, 18, 17, 16};
byte colPins[COLS] = {27, 26, 25, 33};

const int ACCOUNT_NUMBER_LENGTH = 6;
const unsigned long ACTIVE_ACCOUNT_TIMEOUT_MS = 60000;
const unsigned long SESSION_POLL_INTERVAL_MS = 2000;
const int QR_REFRESH_HTTP_TIMEOUT_MS = 5000;

const int VISION_UART_BAUD_RATE = 115200;
const int VISION_RX_PIN = 32;

const int SERVO_PIN = 13;
const int POS_ORIGEN = 84;
const int POS_CENTRO = POS_ORIGEN;
const int GRADOS = 95;
const int POS_DERECHA = POS_CENTRO + GRADOS;
const int POS_IZQUIERDA = 0;
const int POS_BOTELLA = POS_IZQUIERDA;
const int POS_LATA = 180;
const int SERVO_MIN_PULSE_US = 500;
const int SERVO_MAX_PULSE_US = 2500;
const int SERVO_STEP_DEGREES = 1;
const unsigned long SERVO_STEP_DELAY_MS = 20;
const unsigned long SERVO_SETTLE_MS = 300;
const unsigned long SERVO_OPEN_HOLD_MS = 350;
const unsigned long SERVO_RETURN_SETTLE_MS = 600;

const int RELAY_PIN = 23; // 3.3V control signal for the 5V relay module input.
const bool RELAY_ACTIVE_HIGH = true; // Set false if the 5V relay module is active-low.

const uint8_t LCD_ADDRESS = 0x27;
const int LCD_COLUMNS = 16;
const int LCD_ROWS = 2;
const int LCD_SDA_PIN = 21;
const int LCD_SCL_PIN = 22;
const unsigned long STATUS_MESSAGE_DELAY_MS = 1200;

Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);
HardwareSerial visionSerial(2);
Servo sortingServo;
LiquidCrystal_I2C lcd(LCD_ADDRESS, LCD_COLUMNS, LCD_ROWS);

String enteredAccountNumber = "";
String activeAccountNumber = "";
String activeSessionId = "";
String uartBuffer = "";
unsigned long activeAccountSetAt = 0;
unsigned long lastSessionPollAt = 0;
bool isProcessingItem = false;
bool activeSessionFromQr = false;
bool qrRefreshInFlight = false;

struct QrRefreshRequest {
  char sessionId[48];
};

struct QrRefreshResult {
  char requestedSessionId[48];
  char sessionId[48];
  char accountNumber[16];
  int httpCode;
  bool requestSucceeded;
  bool armed;
};

QueueHandle_t qrRefreshResults = nullptr;

void connectToWiFi();
void clearActiveAccount(const String& reason);
void handleQrSessionPolling();
bool pollArmedSession();
void startQrSessionRefresh();
void qrSessionRefreshTask(void* parameter);
void handleQrSessionRefreshResult();
bool validateAccountNumber(const String& accountNumber);
bool sendPoints(const String& accountNumber, const String& itemType);
void setRelayIndicator(bool on);
void turnOnRelayIndicator();
void turnOffRelayIndicator();
void handleKeypadInput();
void handleActiveAccountTimeout();
void handleVisionMessages();
void handleVisionLine(const String& line);
bool processDetectedItem(const String& itemType);
void runServoCycle(const String& itemType);
void moveServoSlowly(int targetPosition);
int getServoTargetPosition(const String& itemType);
bool isSupportedItemType(const String& itemType);
String extractJsonString(const String& json, const String& key);
bool jsonHasTrue(const String& json, const String& key);
String formatLine(const String& text);
void showStatus(const String& line1, const String& line2);
void showIdlePrompt();
void showAccountEntry(const String& accountDigits);
void showWaitingForItem();
void showRecognition(const String& itemType);
void showPointsResult(const String& itemType, bool success);

void setup() {
  Serial.begin(115200);
  pinMode(VISION_RX_PIN, INPUT_PULLUP);
  visionSerial.begin(VISION_UART_BAUD_RATE, SERIAL_8N1, VISION_RX_PIN, -1);

  sortingServo.setPeriodHertz(50);
  sortingServo.attach(SERVO_PIN, SERVO_MIN_PULSE_US, SERVO_MAX_PULSE_US);
  sortingServo.write(POS_CENTRO);

  pinMode(RELAY_PIN, OUTPUT);
  turnOffRelayIndicator();

  Wire.begin(LCD_SDA_PIN, LCD_SCL_PIN);
  lcd.init();
  lcd.backlight();
  showStatus("EcoRewards", "Booting...");

  Serial.println("EcoRewards vision controller booting...");
  Serial.println("Waiting for QR session or keypad account number. Press # to confirm, * to clear.");
  Serial.println("Machine code: " + String(MACHINE_CODE));
  // #region agent log
  Serial.println("[agent-debug] Keypad mode: original keypad.getKey() handler");
  // #endregion
  Serial.println("UART RX ready on GPIO32.");

  qrRefreshResults = xQueueCreate(1, sizeof(QrRefreshResult));
  if (qrRefreshResults == nullptr) {
    Serial.println("Could not create QR refresh queue.");
  }

  connectToWiFi();
  showIdlePrompt();
}

void loop() {
  handleKeypadInput();
  handleQrSessionRefreshResult();
  handleActiveAccountTimeout();
  handleQrSessionPolling();
  handleVisionMessages();
  delay(20);
}

void connectToWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  showStatus("Connecting WiFi", "Please wait");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nConnected to WiFi.");
  showStatus("WiFi connected", "Ready");
  delay(STATUS_MESSAGE_DELAY_MS);
}

void setRelayIndicator(bool on) {
  digitalWrite(RELAY_PIN, (RELAY_ACTIVE_HIGH ? on : !on) ? HIGH : LOW);
}

void turnOnRelayIndicator() {
  setRelayIndicator(true);
}

void turnOffRelayIndicator() {
  setRelayIndicator(false);
}

void clearActiveAccount(const String& reason) {
  activeAccountNumber = "";
  activeSessionId = "";
  activeAccountSetAt = 0;
  isProcessingItem = false;
  activeSessionFromQr = false;
  turnOffRelayIndicator();
  Serial.println("Account cleared: " + reason);
  showIdlePrompt();
}

void handleQrSessionPolling() {
  if (isProcessingItem) {
    return;
  }

  if (millis() - lastSessionPollAt < SESSION_POLL_INTERVAL_MS) {
    return;
  }

  lastSessionPollAt = millis();

  if (activeSessionFromQr && activeSessionId.length() > 0) {
    startQrSessionRefresh();
    return;
  }

  if (activeAccountNumber.length() > 0 || enteredAccountNumber.length() > 0) {
    return;
  }

  pollArmedSession();
}

bool pollArmedSession() {
  connectToWiFi();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected.");
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String(SUPABASE_URL) + "/functions/v1/poll-session";

  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  http.addHeader("apikey", SUPABASE_ANON_KEY);

  String body = "{\"machine_code\":\"" + String(MACHINE_CODE) + "\"}";
  int httpCode = http.POST(body);
  String response = http.getString();
  http.end();

  if (httpCode != 200) {
    Serial.println("Session poll failed. HTTP code: " + String(httpCode));
    Serial.println(response);
    return false;
  }

  if (!jsonHasTrue(response, "armed")) {
    return false;
  }

  String accountNumber = extractJsonString(response, "account_number");
  String sessionId = extractJsonString(response, "session_id");

  if (accountNumber.length() == 0 || sessionId.length() == 0) {
    Serial.println("Armed session response missing account_number or session_id.");
    Serial.println(response);
    return false;
  }

  activeAccountNumber = accountNumber;
  activeSessionId = sessionId;
  activeAccountSetAt = millis();
  activeSessionFromQr = true;
  turnOnRelayIndicator();
  Serial.println("QR session armed for account: " + accountNumber);
  Serial.println("Session ID: " + sessionId);
  showWaitingForItem();
  return true;
}

void startQrSessionRefresh() {
  if (qrRefreshInFlight || qrRefreshResults == nullptr) {
    return;
  }

  QrRefreshRequest* request = static_cast<QrRefreshRequest*>(malloc(sizeof(QrRefreshRequest)));
  if (request == nullptr) {
    Serial.println("Could not allocate QR refresh request.");
    return;
  }

  activeSessionId.toCharArray(request->sessionId, sizeof(request->sessionId));
  qrRefreshInFlight = true;
  if (xTaskCreate(qrSessionRefreshTask, "qr-refresh", 8192, request, 1, nullptr) != pdPASS) {
    qrRefreshInFlight = false;
    free(request);
    Serial.println("Could not start QR refresh task.");
  }
}

void qrSessionRefreshTask(void* parameter) {
  QrRefreshRequest* request = static_cast<QrRefreshRequest*>(parameter);
  QrRefreshResult result = {};
  strncpy(result.requestedSessionId, request->sessionId, sizeof(result.requestedSessionId) - 1);
  free(request);

  if (WiFi.status() == WL_CONNECTED) {
    WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    String url = String(SUPABASE_URL) + "/functions/v1/poll-session";

    http.begin(client, url);
    http.setTimeout(QR_REFRESH_HTTP_TIMEOUT_MS);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
    http.addHeader("apikey", SUPABASE_ANON_KEY);

    String body = "{\"machine_code\":\"" + String(MACHINE_CODE) + "\"}";
    result.httpCode = http.POST(body);
    String response = http.getString();
    http.end();

    if (result.httpCode == 200) {
      result.requestSucceeded = true;
      result.armed = jsonHasTrue(response, "armed");
      if (result.armed) {
        extractJsonString(response, "account_number").toCharArray(result.accountNumber, sizeof(result.accountNumber));
        extractJsonString(response, "session_id").toCharArray(result.sessionId, sizeof(result.sessionId));
      }
    }
  } else {
    result.httpCode = -1;
  }

  xQueueSend(qrRefreshResults, &result, 0);
  vTaskDelete(nullptr);
}

void handleQrSessionRefreshResult() {
  if (qrRefreshResults == nullptr) {
    return;
  }

  QrRefreshResult result;
  if (xQueueReceive(qrRefreshResults, &result, 0) != pdTRUE) {
    return;
  }

  qrRefreshInFlight = false;
  if (!activeSessionFromQr || activeSessionId != result.requestedSessionId) {
    return;
  }

  if (!result.requestSucceeded) {
    Serial.println("Active QR session refresh failed. HTTP code: " + String(result.httpCode));
    return;
  }

  if (!result.armed) {
    Serial.println("Active QR session is no longer armed in Supabase.");
    clearActiveAccount("QR session cancelled or expired");
    return;
  }

  if (result.accountNumber[0] == '\0' || result.sessionId[0] == '\0') {
    Serial.println("Active QR refresh response missing account_number or session_id.");
    return;
  }

  activeAccountSetAt = millis();
  if (activeSessionId != result.sessionId) {
    Serial.println("Active QR session changed in Supabase.");
    activeAccountNumber = result.accountNumber;
    activeSessionId = result.sessionId;
    turnOnRelayIndicator();
    showWaitingForItem();
  }
}

bool validateAccountNumber(const String& accountNumber) {
  connectToWiFi();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected.");
    turnOffRelayIndicator();
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String(SUPABASE_URL) + "/functions/v1/validate-account";

  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  http.addHeader("apikey", SUPABASE_ANON_KEY);

  String body = "{\"account_number\":\"" + accountNumber + "\"}";
  int httpCode = http.POST(body);
  String response = http.getString();
  http.end();

  if (httpCode == 200) {
    activeAccountNumber = accountNumber;
    activeSessionId = "";
    activeAccountSetAt = millis();
    activeSessionFromQr = false;
    turnOnRelayIndicator();
    Serial.println("Account validated: " + accountNumber);
    Serial.println(response);
    showStatus("Account valid", "Insert item");
    delay(STATUS_MESSAGE_DELAY_MS);
    showWaitingForItem();
    return true;
  }

  Serial.println("Invalid account number. HTTP code: " + String(httpCode));
  Serial.println(response);
  showStatus("Invalid account", "Try again");
  delay(STATUS_MESSAGE_DELAY_MS);
  turnOffRelayIndicator();
  showIdlePrompt();
  return false;
}

bool sendPoints(const String& accountNumber, const String& itemType) {
  connectToWiFi();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected.");
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String(SUPABASE_URL) + "/functions/v1/add-points";

  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  http.addHeader("apikey", SUPABASE_ANON_KEY);

  int points = itemType == "bottle" ? 15 : 10;
  String body = "{\"account_number\":\"" + accountNumber + "\",\"item_type\":\"" + itemType + "\",\"points\":" + String(points);
  if (activeSessionId.length() > 0) {
    body += ",\"session_id\":\"" + activeSessionId + "\",\"machine_code\":\"" + String(MACHINE_CODE) + "\"";
  }
  body += "}";
  int httpCode = http.POST(body);
  String response = http.getString();
  http.end();

  if (httpCode == 200) {
    Serial.println("Points sent successfully: " + response);
    return true;
  }

  Serial.println("Error sending points. HTTP code: " + String(httpCode));
  Serial.println(response);
  return false;
}

void handleKeypadInput() {
  char key = keypad.getKey();
  if (!key) {
    return;
  }

  // #region agent log
  Serial.println("[agent-debug] keypad.getKey returned: " + String(key));
  // #endregion

  if (key >= '0' && key <= '9') {
    if (enteredAccountNumber.length() < ACCOUNT_NUMBER_LENGTH) {
      if (enteredAccountNumber.length() == 0) {
        turnOnRelayIndicator();
      }

      enteredAccountNumber += key;
      Serial.println("Entered: " + enteredAccountNumber);
      showAccountEntry(enteredAccountNumber);
    }
    return;
  }

  if (key == '*') {
    enteredAccountNumber = "";
    clearActiveAccount("manual clear");
    Serial.println("Entry cleared.");
    showStatus("Session cleared", "Enter account");
    delay(STATUS_MESSAGE_DELAY_MS);
    showIdlePrompt();
    return;
  }

  if (key == '#') {
    if (enteredAccountNumber.length() != ACCOUNT_NUMBER_LENGTH) {
      Serial.println("Please enter a 6-digit account number.");
      showStatus("Need 6 digits", "Press # again");
      delay(STATUS_MESSAGE_DELAY_MS);
      showAccountEntry(enteredAccountNumber);
      return;
    }

    showStatus("Validating...", enteredAccountNumber);
    if (validateAccountNumber(enteredAccountNumber)) {
      Serial.println("Controller armed and waiting for vision detection.");
    }

    enteredAccountNumber = "";
  }
}

void handleActiveAccountTimeout() {
  if (activeAccountNumber.length() > 0 && millis() - activeAccountSetAt > ACTIVE_ACCOUNT_TIMEOUT_MS) {
    showStatus("Session cleared", "Timeout");
    delay(STATUS_MESSAGE_DELAY_MS);
    clearActiveAccount("timeout");
  }
}

void handleVisionMessages() {
  while (visionSerial.available() > 0) {
    char incoming = static_cast<char>(visionSerial.read());

    if (incoming == '\r') {
      continue;
    }

    if (incoming == '\n') {
      if (uartBuffer.length() > 0) {
        handleVisionLine(uartBuffer);
        uartBuffer = "";
      }
      continue;
    }

    uartBuffer += incoming;

    if (uartBuffer.length() > 64) {
      Serial.println("UART buffer overflow, clearing partial message.");
      uartBuffer = "";
    }
  }
}

void handleVisionLine(const String& line) {
  Serial.println("UART received: " + line);

  if (!line.startsWith("DETECT:")) {
    Serial.println("Ignoring unknown UART message.");
    showStatus("UART ignored", "Unknown msg");
    delay(STATUS_MESSAGE_DELAY_MS);
    if (activeAccountNumber.length() > 0) {
      showWaitingForItem();
    } else {
      showIdlePrompt();
    }
    return;
  }

  String itemType = line.substring(7);
  itemType.trim();

  if (!isSupportedItemType(itemType)) {
    Serial.println("Ignoring unsupported item type: " + itemType);
    showStatus("Unknown item", itemType);
    delay(STATUS_MESSAGE_DELAY_MS);
    showWaitingForItem();
    return;
  }

  if (activeAccountNumber.length() == 0) {
    Serial.println("Detection ignored because no validated account is active.");
    showStatus("No account", "Enter number");
    delay(STATUS_MESSAGE_DELAY_MS);
    showIdlePrompt();
    return;
  }

  if (isProcessingItem) {
    Serial.println("Detection ignored because another item is already being processed.");
    showStatus("Busy", "Please wait");
    delay(STATUS_MESSAGE_DELAY_MS);
    showWaitingForItem();
    return;
  }

  isProcessingItem = true;
  showRecognition(itemType);
  delay(STATUS_MESSAGE_DELAY_MS);

  if (!processDetectedItem(itemType)) {
    isProcessingItem = false;
  }
}

bool processDetectedItem(const String& itemType) {
  Serial.println("Accepted detection for: " + itemType);
  runServoCycle(itemType);
  Serial.println("Servo cycle complete, sending points...");

  if (sendPoints(activeAccountNumber, itemType)) {
    showPointsResult(itemType, true);
    delay(STATUS_MESSAGE_DELAY_MS);
    turnOffRelayIndicator();
    clearActiveAccount("points added for " + itemType);
    return true;
  }

  Serial.println("Points request failed, keeping the active account for retry.");
  showPointsResult(itemType, false);
  delay(STATUS_MESSAGE_DELAY_MS);
  turnOffRelayIndicator();
  return false;
}

void runServoCycle(const String& itemType) {
  int targetPosition = getServoTargetPosition(itemType);

  showStatus("Sorting item", "Please wait");
  Serial.println("Sorting " + itemType + " with servo at position " + String(targetPosition));

  moveServoSlowly(targetPosition);
  delay(SERVO_SETTLE_MS);
  delay(SERVO_OPEN_HOLD_MS);

  Serial.println("Returning servo to center.");
  moveServoSlowly(POS_ORIGEN);
  delay(SERVO_RETURN_SETTLE_MS);
}

void moveServoSlowly(int targetPosition) {
  int currentPosition = sortingServo.read();
  int direction = targetPosition > currentPosition ? SERVO_STEP_DEGREES : -SERVO_STEP_DEGREES;

  while (currentPosition != targetPosition) {
    currentPosition += direction;

    if ((direction > 0 && currentPosition > targetPosition) || (direction < 0 && currentPosition < targetPosition)) {
      currentPosition = targetPosition;
    }

    sortingServo.write(currentPosition);
    delay(SERVO_STEP_DELAY_MS);
  }
}

int getServoTargetPosition(const String& itemType) {
  if (itemType == "bottle") {
    return POS_BOTELLA;
  }

  return POS_LATA;
}

bool isSupportedItemType(const String& itemType) {
  return itemType == "bottle" || itemType == "can";
}

String formatLine(const String& text) {
  String line = text;

  if (line.length() > LCD_COLUMNS) {
    line = line.substring(0, LCD_COLUMNS);
  }

  while (line.length() < LCD_COLUMNS) {
    line += " ";
  }

  return line;
}

String extractJsonString(const String& json, const String& key) {
  String pattern = "\"" + key + "\":";
  int keyIndex = json.indexOf(pattern);
  if (keyIndex < 0) {
    return "";
  }

  int valueStart = json.indexOf("\"", keyIndex + pattern.length());
  if (valueStart < 0) {
    return "";
  }

  int valueEnd = json.indexOf("\"", valueStart + 1);
  if (valueEnd < 0) {
    return "";
  }

  return json.substring(valueStart + 1, valueEnd);
}

bool jsonHasTrue(const String& json, const String& key) {
  String pattern = "\"" + key + "\":true";
  return json.indexOf(pattern) >= 0;
}

void showStatus(const String& line1, const String& line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(formatLine(line1));
  lcd.setCursor(0, 1);
  lcd.print(formatLine(line2));
}

void showIdlePrompt() {
  showStatus("Scan QR in app", "Or enter acct #");
}

void showAccountEntry(const String& accountDigits) {
  showStatus("Account:", accountDigits);
}

void showWaitingForItem() {
  String accountSuffix = activeSessionFromQr ? "QR armed" : activeAccountNumber;
  if (accountSuffix.length() == 0) {
    accountSuffix = enteredAccountNumber;
  }
  showStatus("Waiting item...", accountSuffix);
}

void showRecognition(const String& itemType) {
  String label = itemType == "bottle" ? "Bottle" : "Can";
  showStatus("Detected:", label);
}

void showPointsResult(const String& itemType, bool success) {
  if (!success) {
    showStatus("Points failed", "Retry item");
    return;
  }

  if (itemType == "bottle") {
    showStatus("Bottle +15 pts", "Success");
    return;
  }

  showStatus("Can +10 pts", "Success");
}
