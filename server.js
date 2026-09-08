require('dotenv').config();
const express = require('express');
const Telnyx = require('telnyx');
const db = require('./db');

const telnyx = new Telnyx({
  apiKey: process.env.TELNYX_API_KEY
});
const app = express();

app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
}));

const PORT = process.env.PORT || 8000;
const SALES_PHONE_NUMBER = process.env.SALES_PHONE_NUMBER;
const RECORD_CALLS = process.env.RECORD_CALLS === 'true';


// Manage tracking numbers

app.post('/numbers', (req, res) => { 
    const { phone_number, campaign_id, sender_id, telnyx_number_id } = req.body;
    if (!phone_number || !campaign_id) {
        return res.status(400).json({ error: 'phone_number and campaign_id are required' });
    }
    const stmt = db.prepare(`
        INSERT INTO numbers (phone_number, telnyx_number_id, campaign_id, sender_id) 
        VALUES (?, ?, ?, ?)
    `);
    const info = stmt.run(phone_number, telnyx_number_id || null, campaign_id, sender_id || null);
    res.json({ id: info.lastInsertRowid, phone_number, campaign_id});
});

app.get('/numbers', (req, res) => {
    const rows = db.prepare('SELECT * FROM numbers ORDER BY created_at DESC').all();
    res.json(rows);
});

app.get('/calls', (req, res) => {
    const rows = db.prepare('SELECT * FROM calls ORDER BY started_at DESC LIMIT 100').all();
    res.json(rows);
});


// Webhook from Telnyx - all call events are sent here
app.post('/webhooks/telnyx', async (req, res) => {
    res.sendStatus(200); 

    const event = req.body?.data;
    if (!event) {
        console.error('No event data in webhook');
        return;
    }

    const eventType = event.event_type;
    const payload = event.payload;

    console.log('Event from Telnyx:', eventType);

    try {
        if (eventType === 'call.initiated') {
            await handleCallInitiated(payload);
        } else if (eventType === 'call.answered') {
            handleCallAnswered(payload);
        } else if (eventType === 'call.hangup') {
            handleCallHangup(payload);
        } else if (eventType === 'call.recording.saved') {
            handleRecordingSaved(payload);
        } else if (eventType === 'call.transcription') {
            handleTranscription(payload);
        }
    } catch (err) {
        console.error(`Error handling ${eventType}:`, err);
    }
});


// Incoming call to tracking number -> find campaign -> forward to real phone 

async function handleCallInitiated(payload) {
    if (payload.direction !== 'incoming') return;

    const trackingNumber = payload.to;
    const fromNumber = payload.from;
    const callControlId = payload.call_control_id;

    const numberRow = db.prepare('SELECT * FROM numbers WHERE phone_number = ?').get(trackingNumber);
    const campaignId = numberRow ? numberRow.campaign_id : null;

    db.prepare(`INSERT INTO calls (call_control_id, tracking_number, from_number, campaign_id, status) 
        VALUES (?, ?, ?, ?, 'ringing')
    `).run(callControlId, trackingNumber, fromNumber, campaignId);

    console.log(`Incoming call from ${fromNumber} to tracking number ${trackingNumber} (campaign: ${campaignId || 'unknown'})`);

    await telnyx.calls.actions.answer(callControlId);

    const dialParams = {
        connection_id: process.env.TELNYX_CONNECTION_ID,
        to: SALES_PHONE_NUMBER,
        from: trackingNumber,
    };

    if (RECORD_CALLS) {
        dialParams.record = 'record-from-answer';
        dialParams.record_channels = 'dual';
        dialParams.record_format = 'mp3';
    }

    const dialResult = await telnyx.calls.dial(dialParams);

    const callLegId = dialResult?.data?.call_leg_id;

    db.prepare('UPDATE calls SET call_leg_id = ? WHERE call_control_id = ?')
    .run(callLegId || null, callControlId);
}

function handleCallAnswered(payload) {
  db.prepare(`
    UPDATE calls SET status = 'answered', answered_at = datetime('now')
    WHERE call_control_id = ? OR call_leg_id = ?
  `).run(payload.call_control_id, payload.call_leg_id);
}

function handleCallHangup(payload) {
  const row = db.prepare(`
    SELECT * FROM calls WHERE call_control_id = ? OR call_leg_id = ?
  `).get(payload.call_control_id, payload.call_leg_id);

  if (!row) return;

  const finalStatus = row.answered_at ? 'completed' : 'no-answer';
  let duration = null;
  if (row.answered_at) {
    duration = Math.round((Date.now() - new Date(row.answered_at + 'Z').getTime()) / 1000);
  }

  db.prepare(`
    UPDATE calls SET status = ?, ended_at = datetime('now'), duration_seconds = ?
    WHERE id = ?
  `).run(finalStatus, duration, row.id);

  console.log(`Call ${row.id} ended. Status: ${finalStatus}, Duration: ${duration || 0}s`);
}

function handleRecordingSaved(payload) {
  const callLegId = payload.call_leg_id;
  const recordingUrl = payload.recording_urls?.mp3 || payload.public_recording_urls?.mp3;

  db.prepare(`
    UPDATE calls SET recording_url = ? WHERE call_leg_id = ?
  `).run(recordingUrl || null, callLegId);

  console.log(`Recording saved for call_leg_id ${callLegId}`);
}

function handleTranscription(payload) {
  const callLegId = payload.call_leg_id;
  const transcriptText = payload.transcription_data?.transcript;
  if (!transcriptText) return;

  db.prepare('UPDATE calls SET transcript = ? WHERE call_leg_id = ?').run(transcriptText, callLegId);

  console.log(`Transcript saved for call_leg_id ${callLegId}`);
}


app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Webhook URL for configuration in Telnyx: http://localhost:${PORT}/webhooks/telnyx`);
});