const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const RATE_PER_KWH = 22;

// MQTT CONFIG
const MQTT_HOST = 'mqtts://4864dde839b2426c9e7ac0a2232ef9a4.s1.eu.hivemq.cloud';
const MQTT_USER = 'raweproxy';
const MQTT_PASS = 'Rawe1234';
const MQTT_TOPIC = 'sonoff1';

const client = mqtt.connect(MQTT_HOST, {
  port: 8883,
  username: MQTT_USER,
  password: MQTT_PASS,
  protocol: 'mqtts'
});

let powerData = {
  voltage: 0, current: 0, power: 0,
  todayKwh: 0, totalKwh: 0, cost: '0.00'
};

client.on('connect', () => {
  console.log('MQTT Connected to HiveMQ!');
  client.subscribe(`tele/${MQTT_TOPIC}/SENSOR`);
  client.subscribe(`stat/${MQTT_TOPIC}/POWER`);
});

client.on('message', (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    if (topic === `tele/${MQTT_TOPIC}/SENSOR` && data.ENERGY) {
      const e = data.ENERGY;
      powerData = {
        voltage: e.Voltage,
        current: e.Current,
        power: e.Power,
        todayKwh: e.Today,
        totalKwh: e.Total,
        cost: (e.Today * RATE_PER_KWH).toFixed(2)
      };
    }
  } catch (err) {}
});

client.on('error', (err) => {
  console.log('MQTT Error:', err.message);
});

// ── STATE ──
const SCHEDULE = { enabled: false, startHour: 6, endHour: 22 };

function isWithinSchedule() {
  if (!SCHEDULE.enabled) return true;
  const hour = new Date().getHours();
  return hour >= SCHEDULE.startHour && hour < SCHEDULE.endHour;
}

let stationStatus = { state: 'FREE', user: null, startedAt: null };
let currentOTP = null;
let isBlocked = false;
let parkingStatus = {
  available: true, free: true, rate: 20,
  slots: [true, true, true, true]
};

// key: otp → { status, user, time }
let pendingRequests = {};
let adminMode = 'auto'; // 'auto' | 'approval'

// ── OTP ──
app.get('/request-otp', (req, res) => {
  currentOTP = Math.floor(100000 + Math.random() * 900000).toString();
  console.log(`OTP generated: ${currentOTP}`);
  res.send({ message: 'OTP generated.', otp: currentOTP });
});

// ── STATUS ──
// If ?otp= is provided, return that request's approval status
// Otherwise return overall station status
app.get('/status', (req, res) => {
  const { otp } = req.query;
  if (otp && pendingRequests[otp]) {
    return res.send({ status: pendingRequests[otp].status });
  }
  res.send({ ...stationStatus, blocked: isBlocked });
});

// ── ON ──
app.get('/on', (req, res) => {
  if (isBlocked) return res.status(403).send({ error: 'Station is blocked by admin' });
  if (stationStatus.state === 'BUSY') return res.status(409).send({ error: 'Station is currently BUSY' });
  if (!isWithinSchedule()) return res.status(403).send({ error: 'Station is closed. Allowed hours: 6am-10pm' });
  if (!req.query.otp || req.query.otp !== currentOTP) return res.status(401).send({ error: 'Invalid or missing OTP' });

  const user = req.query.user || 'Guest';

  if (adminMode === 'auto') {
    client.publish(`cmnd/${MQTT_TOPIC}/Power`, 'ON');
    console.log('Sonoff turned ON via MQTT');
    currentOTP = null;
    stationStatus = { state: 'BUSY', user, startedAt: new Date() };
    res.send({ status: 'APPROVED', station: stationStatus });
  } else {
    // Save the OTP with timestamp so admin panel can list it
    pendingRequests[currentOTP] = {
      status: 'PENDING',
      user,
      otp: currentOTP,
      time: new Date().toISOString()
    };
    console.log(`Pending request from ${user} (OTP: ${currentOTP})`);
    res.send({ status: 'PENDING', message: 'Waiting for admin approval' });
  }
});

// ── OFF ──
app.get('/off', (req, res) => {
  client.publish(`cmnd/${MQTT_TOPIC}/Power`, 'OFF');
  console.log('Sonoff turned OFF via MQTT');
  stationStatus = { state: 'FREE', user: null, startedAt: null };
  res.send({ status: 'OFF', station: stationStatus });
});

// ══════════════ ADMIN ROUTES ══════════════

// GET all pending requests (for admin panel list)
app.get('/admin/requests', (req, res) => {
  const list = Object.values(pendingRequests);
  res.send(list);
});

// Switch booking mode
app.post('/admin/mode', (req, res) => {
  const { mode } = req.body; // 'auto' | 'approval'
  adminMode = mode;
  console.log(`Admin mode set to: ${mode}`);
  res.send({ success: true, mode });
});

// Approve a request
app.post('/admin/approve', (req, res) => {
  const { otp } = req.body;
  if (pendingRequests[otp]) {
    pendingRequests[otp].status = 'APPROVED';
    client.publish(`cmnd/${MQTT_TOPIC}/Power`, 'ON');
    stationStatus = { state: 'BUSY', user: pendingRequests[otp].user, startedAt: new Date() };
    console.log(`Approved request OTP: ${otp}, user: ${pendingRequests[otp].user}`);
    res.send({ success: true, otp });
  } else {
    res.send({ success: false, message: 'OTP not found' });
  }
});

// Reject a request
app.post('/admin/reject', (req, res) => {
  const { otp } = req.body;
  if (pendingRequests[otp]) {
    pendingRequests[otp].status = 'REJECTED';
    console.log(`Rejected request OTP: ${otp}`);
    res.send({ success: true, otp });
  } else {
    res.send({ success: false, message: 'OTP not found' });
  }
});

// Force power ON/OFF
app.post('/admin/force', (req, res) => {
  const { action } = req.body; // 'ON' | 'OFF'
  client.publish(`cmnd/${MQTT_TOPIC}/Power`, action);
  if (action === 'OFF') {
    stationStatus = { state: 'FREE', user: null, startedAt: null };
  }
  console.log(`Admin force ${action}`);
  res.send({ success: true, action });
});

// Block / Unblock
app.get('/admin/block', (req, res) => {
  isBlocked = true;
  console.log('Station BLOCKED by admin');
  res.send({ message: 'Station BLOCKED by admin' });
});

app.get('/admin/unblock', (req, res) => {
  isBlocked = false;
  console.log('Station UNBLOCKED by admin');
  res.send({ message: 'Station UNBLOCKED by admin' });
});

// ── POWER ──
app.get('/power', (req, res) => {
  res.send(powerData);
});

// ── PARKING ──
app.get('/parking', (req, res) => {
  res.send(parkingStatus);
});

app.post('/parking/update', (req, res) => {
  const { available, free, rate, slots } = req.body;
  if (available !== undefined) parkingStatus.available = available;
  if (free !== undefined) parkingStatus.free = free;
  if (rate !== undefined) parkingStatus.rate = rate;
  if (slots !== undefined) parkingStatus.slots = slots;
  res.send({ message: 'Parking updated', parking: parkingStatus });
});

app.listen(3000, () => {
  console.log('RAWE Server running at http://localhost:3000');
});
