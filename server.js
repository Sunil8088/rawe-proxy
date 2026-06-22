const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const TASMOTA_IP = "172.20.10.3";
const RATE_PER_KWH = 22;

const SCHEDULE = {
    enabled: false,
    startHour: 6,
    endHour: 22
};

function isWithinSchedule() {
    if (!SCHEDULE.enabled) return true;
    const hour = new Date().getHours();
    return hour >= SCHEDULE.startHour && hour < SCHEDULE.endHour;
}

let stationStatus = {
    state: "FREE",
    user: null,
    startedAt: null
};

let currentOTP = null;
let isBlocked = false;
let parkingStatus = {
    available: true,
    free: true,
    rate: 20,
    slots: [true, true, true, true]
};

// OTP
app.get('/request-otp', (req, res) => {
    currentOTP = Math.floor(100000 + Math.random() * 900000).toString();
    console.log(`OTP generated: ${currentOTP}`);
    res.send({ message: "OTP generated.", otp: currentOTP });
});

// STATUS
app.get('/status', (req, res) => {
    res.send({ ...stationStatus, blocked: isBlocked });
});

// ON
app.get('/on', async (req, res) => {
    if (isBlocked) return res.status(403).send({ error: "Station is blocked by admin" });
    if (stationStatus.state === "BUSY") return res.status(409).send({ error: "Station is currently BUSY" });
    if (!isWithinSchedule()) return res.status(403).send({ error: "Station is closed. Allowed hours: 6am-10pm" });
    if (!req.query.otp || req.query.otp !== currentOTP) return res.status(401).send({ error: "Invalid or missing OTP" });

    // Try to turn on Sonoff
    try {
        await axios.get(`http://${TASMOTA_IP}/cm?cmnd=Power%20ON`, { timeout: 3000 });
        console.log("Sonoff turned ON");
    } catch (e) {
        console.log("Sonoff unreachable - continuing anyway");
    }

    currentOTP = null;
    stationStatus = {
        state: "BUSY",
        user: req.query.user || "Guest",
        startedAt: new Date()
    };
    res.send({ status: 'ON', station: stationStatus });
});

// OFF
app.get('/off', async (req, res) => {
    // Try to turn off Sonoff
    try {
        await axios.get(`http://${TASMOTA_IP}/cm?cmnd=Power%20OFF`, { timeout: 3000 });
        console.log("Sonoff turned OFF");
    } catch (e) {
        console.log("Sonoff unreachable - continuing anyway");
    }

    stationStatus = {
        state: "FREE",
        user: null,
        startedAt: null
    };
    res.send({ status: 'OFF', station: stationStatus });
});

// ADMIN BLOCK/UNBLOCK
app.get('/admin/block', (req, res) => {
    isBlocked = true;
    res.send({ message: "Station BLOCKED by admin" });
});

app.get('/admin/unblock', (req, res) => {
    isBlocked = false;
    res.send({ message: "Station UNBLOCKED by admin" });
});

// POWER DATA from Sonoff
app.get('/power', async (req, res) => {
    try {
        const response = await axios.get(
            `http://${TASMOTA_IP}/cm?cmnd=Status%208`,
            { timeout: 5000 }
        );
        const energy = response.data.StatusSNS.ENERGY;
        res.send({
            voltage:  energy.Voltage,
            current:  energy.Current,
            power:    energy.Power,
            todayKwh: energy.Today,
            totalKwh: energy.Total,
            cost:     (energy.Today * RATE_PER_KWH).toFixed(2)
        });
    } catch (e) {
        console.log("Tasmota power error:", e.message);
        res.status(500).send({
            error: "Could not read power data",
            voltage: 0, current: 0, power: 0,
            todayKwh: 0, totalKwh: 0, cost: "0.00"
        });
    }
});

// PARKING STATUS
app.get('/parking', (req, res) => {
    res.send(parkingStatus);
});

app.post('/parking/update', (req, res) => {
    const { available, free, rate, slots } = req.body;
    if (available !== undefined) parkingStatus.available = available;
    if (free !== undefined) parkingStatus.free = free;
    if (rate !== undefined) parkingStatus.rate = rate;
    if (slots !== undefined) parkingStatus.slots = slots;
    res.send({ message: "Parking updated", parking: parkingStatus });
});

app.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
    console.log(`Tasmota IP: ${TASMOTA_IP}`);
});