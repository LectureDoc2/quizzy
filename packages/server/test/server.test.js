import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'ws';
import { RoomManager } from '../src/rooms.js';

describe('Server Integration', () => {
  let server;
  let port;
  let wss;
  let roomManager;

  before(async () => {
    const app = express();
    const MAX_QUIZ_SIZE = 1024 * 1024; // 1MB
    roomManager = new RoomManager();
    
    // CORS middleware
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });
    
    // API endpoint
    app.get('/api/sessions', (req, res) => {
      const token = req.query.token;
      if (!token) {
        return res.status(400).json({ error: 'Missing token' });
      }
      const sessions = roomManager.getPresenterRooms(token);
      res.json({ sessions });
    });
    
    server = createServer(app);
    wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_QUIZ_SIZE });
    
    // Simple echo handler for testing
    wss.on('connection', (ws) => {
      ws.on('error', () => {});
      ws.on('message', (data) => {
        try {
          const dataSize = Buffer.byteLength(data);
          if (dataSize > MAX_QUIZ_SIZE) {
            ws.send(JSON.stringify({ type: 'error', message: 'Quiz data exceeds maximum size of 1MB' }));
            return;
          }
          const msg = JSON.parse(data);
          if (msg.type === 'create_room') {
            const room = roomManager.createRoom(msg.presenterToken, msg.quiz);
            ws.send(JSON.stringify({
              type: 'room_created',
              roomId: room.roomId,
              quizTitle: room.quiz.title,
              totalQuestions: room.quiz.questions.length
            }));
          } else if (msg.type === 'join_room') {
            const room = roomManager.getRoom(msg.roomId);
            if (room) {
              const p = room.addParticipant(ws, msg.name);
              ws.send(JSON.stringify({
                type: 'joined',
                participantId: p.id,
                roomId: msg.roomId,
                quizTitle: room.quiz.title
              }));
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
            }
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
        }
      });
    });
    
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
    });
    await new Promise((resolve) => {
      wss.close(resolve);
    });
  });

  it('handles OPTIONS preflight', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'OPTIONS',
      headers: { 'Origin': 'http://other-origin.com' }
    });
    assert.strictEqual(res.status, 204);
    assert.ok(res.headers.get('access-control-allow-origin'));
    assert.ok(res.headers.get('access-control-allow-methods'));
  });

  it('/api/sessions returns 400 for missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error, 'Missing token');
  });

  it('/api/sessions returns empty array for unknown token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions?token=abc123`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.sessions, []);
  });

  it('/api/sessions returns sessions for known token', async () => {
    const token = 'test-token-123';
    const quiz = { title: 'Test Quiz', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] }] };
    roomManager.createRoom(token, quiz);
    
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions?token=${token}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.sessions.length, 1);
    assert.strictEqual(body.sessions[0].title, 'Test Quiz');
  });

  it('WebSocket create_room returns room_created', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    
    const quiz = { title: 'WS Quiz', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] }] };
    ws.send(JSON.stringify({ type: 'create_room', presenterToken: 'ws-token', quiz }));
    
    const msg = await new Promise((resolve, reject) => {
      ws.on('message', (data) => resolve(JSON.parse(data)));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });
    
    assert.strictEqual(msg.type, 'room_created');
    assert.ok(msg.roomId);
    assert.strictEqual(msg.quizTitle, 'WS Quiz');
    assert.strictEqual(msg.totalQuestions, 1);
    
    ws.close();
  });

  it('WebSocket rejects oversized create_room payload', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    
    const bigQuestion = { type: 'multiple-choice', text: 'x'.repeat(2 * 1024 * 1024), options: ['A', 'B'], correctIndices: [0] };
    const quiz = { title: 'Oversized', questions: [bigQuestion] };
    ws.send(JSON.stringify({ type: 'create_room', presenterToken: 'oversized-token', quiz }));
    
    const result = await new Promise((resolve) => {
      ws.on('message', (data) => resolve({ kind: 'message', msg: JSON.parse(data) }));
      ws.on('close', () => resolve({ kind: 'close' }));
      setTimeout(() => resolve({ kind: 'timeout' }), 2000);
    });
    
    ws.close();
    ws.terminate();
    
    if (result.kind === 'message') {
      assert.strictEqual(result.msg.type, 'error');
      assert.ok(result.msg.message.includes('1MB'));
    }
    assert.notStrictEqual(result.kind, 'timeout', 'Oversized payload should be rejected');
  });

  it('WebSocket join_room returns error for nonexistent room', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    
    ws.send(JSON.stringify({ type: 'join_room', roomId: 'FAKE99', name: 'Alice' }));
    
    const msg = await new Promise((resolve, reject) => {
      ws.on('message', (data) => resolve(JSON.parse(data)));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });
    
    assert.strictEqual(msg.type, 'error');
    assert.strictEqual(msg.message, 'Room not found');
    
    ws.close();
  });

  it('WebSocket join_room succeeds for existing room', async () => {
    // Create room first
    const presenterWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      presenterWs.on('open', resolve);
      presenterWs.on('error', reject);
    });
    
    const quiz = { title: 'Join Test', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] }] };
    presenterWs.send(JSON.stringify({ type: 'create_room', presenterToken: 'join-test-token', quiz }));
    
    const roomMsg = await new Promise((resolve, reject) => {
      presenterWs.on('message', (data) => resolve(JSON.parse(data)));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });
    const roomId = roomMsg.roomId;
    
    // Now join as participant
    const participantWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      participantWs.on('open', resolve);
      participantWs.on('error', reject);
    });
    
    participantWs.send(JSON.stringify({ type: 'join_room', roomId, name: 'Alice' }));
    
    const joinMsg = await new Promise((resolve, reject) => {
      participantWs.on('message', (data) => resolve(JSON.parse(data)));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });
    
    assert.strictEqual(joinMsg.type, 'joined');
    assert.ok(joinMsg.participantId);
    assert.strictEqual(joinMsg.roomId, roomId);
    assert.strictEqual(joinMsg.quizTitle, 'Join Test');
    
    presenterWs.close();
    participantWs.close();
  });
});
