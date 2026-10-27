const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');

const mockAdminId = '111111111111111111111111';
const mockUserId = '222222222222222222222222';

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    if (!req.headers['x-test-role']) return res.sendStatus(401);
    req.user = {
      id: req.headers['x-test-role'] === 'admin' ? mockAdminId : mockUserId,
      role: req.headers['x-test-role'],
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    };
    return next();
  },
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: () => (req, res, next) =>
    req.user?.role === 'admin' ? next() : res.sendStatus(403),
}));

const adminRouter = require('../admin/releases');
const publicRouter = require('../releases');

let mongoServer;
let app;
let Release;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ({ Release } = createModels(mongoose));
  app = express();
  app.use(express.json());
  app.use('/api/admin/releases', adminRouter);
  app.use('/api/releases', publicRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
});

const asAdmin = (call) => call.set('x-test-role', 'admin');
const asUser = (call) => call.set('x-test-role', 'user');

describe('release routes', () => {
  it('requires auth and admin capability', async () => {
    await request(app).get('/api/admin/releases').expect(401);
    await asUser(request(app).get('/api/admin/releases')).expect(403);
    await asUser(request(app).post('/api/admin/releases').send({ text: 'x' })).expect(403);
    await asUser(
      request(app).put('/api/admin/releases/111111111111111111111111').send({ text: 'x' }),
    ).expect(403);
    await asUser(request(app).delete('/api/admin/releases/111111111111111111111111')).expect(403);
    await request(app).get('/api/releases').expect(401);
  });

  it('publishes, edits without resetting unread, then unpublishes', async () => {
    const created = await asAdmin(
      request(app).post('/api/admin/releases').send({ text: 'One' }),
    ).expect(201);
    const id = created.body.release._id;
    expect((await asUser(request(app).get('/api/releases')).expect(200)).body.items).toEqual([]);
    await asAdmin(request(app).post(`/api/admin/releases/${id}/publish`)).expect(200);
    const first = await asUser(request(app).get('/api/releases/status')).expect(200);
    expect(first.body.unreadCount).toBe(1);
    const date = (await Release.findById(id)).publishedAt.toISOString();
    await asUser(request(app).post('/api/releases/seen').send({ seenUpTo: date })).expect(200);
    await asAdmin(
      request(app)
        .put(`/api/admin/releases/${id}`)
        .send({ text: '<script>alert(1)</script>\nplain' }),
    ).expect(200);
    expect((await Release.findById(id)).publishedAt.toISOString()).toBe(date);
    const list = await asUser(request(app).get('/api/releases')).expect(200);
    expect(list.body.items[0].text).toBe('<script>alert(1)</script>\nplain');
    expect(list.body.items[0]).not.toHaveProperty('createdBy');
    expect(list.body.items[0].isUnread).toBe(false);
    await asAdmin(request(app).post(`/api/admin/releases/${id}/unpublish`)).expect(200);
    expect(
      (await asUser(request(app).get('/api/releases/status')).expect(200)).body.unreadCount,
    ).toBe(0);
  });

  it('paginates 55 releases without duplicates when dates tie', async () => {
    const publishedAt = new Date('2024-01-02T00:00:00.000Z');
    await Release.collection.insertMany(
      Array.from({ length: 55 }, (_, index) => ({
        _id: new mongoose.Types.ObjectId(),
        title: '',
        text: `Release ${index}`,
        isPublished: true,
        publishedAt: new Date(publishedAt.getTime() - Math.floor(index / 30) * 1000),
        createdAt: new Date(publishedAt.getTime() - Math.floor(index / 25) * 1000),
        updatedAt: publishedAt,
        createdBy: new mongoose.Types.ObjectId(mockAdminId),
        updatedBy: new mongoose.Types.ObjectId(mockAdminId),
      })),
    );
    for (const prefix of ['/api/releases', '/api/admin/releases']) {
      let cursor;
      const ids = [];
      do {
        const response = await asAdmin(
          request(app)
            .get(prefix)
            .query({ limit: 20, ...(cursor ? { cursor } : {}) }),
        ).expect(200);
        ids.push(...response.body.items.map((item) => item.id ?? item._id));
        cursor = response.body.nextCursor;
      } while (cursor);
      expect(ids).toHaveLength(55);
      expect(new Set(ids).size).toBe(55);
    }
    await asUser(request(app).get('/api/releases').query({ cursor: 'bad' })).expect(400);
  });

  it('does not mark a newer release as seen using an earlier timestamp', async () => {
    const first = await asAdmin(
      request(app).post('/api/admin/releases').send({ text: 'first' }),
    ).expect(201);
    await asAdmin(
      request(app).post(`/api/admin/releases/${first.body.release._id}/publish`),
    ).expect(200);
    const seenUpTo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await Release.updateOne(
      { _id: first.body.release._id },
      { $set: { publishedAt: new Date(seenUpTo) } },
    );
    const second = await asAdmin(
      request(app).post('/api/admin/releases').send({ text: 'second' }),
    ).expect(201);
    await asAdmin(
      request(app).post(`/api/admin/releases/${second.body.release._id}/publish`),
    ).expect(200);
    await Release.updateOne(
      { _id: second.body.release._id },
      { $set: { publishedAt: new Date(new Date(seenUpTo).getTime() + 60 * 60 * 1000) } },
    );
    const seen = await asUser(request(app).post('/api/releases/seen').send({ seenUpTo })).expect(
      200,
    );
    expect(seen.body.unreadCount).toBe(1);
    const newerDate = new Date(new Date(seenUpTo).getTime() + 60 * 60 * 1000).toISOString();
    await asUser(request(app).post('/api/releases/seen').send({ seenUpTo: newerDate })).expect(200);
    await asUser(request(app).post('/api/releases/seen').send({ seenUpTo })).expect(200);
    expect(
      (await asUser(request(app).get('/api/releases/status')).expect(200)).body.unreadCount,
    ).toBe(0);
    await asUser(request(app).post('/api/releases/seen').send({ seenUpTo: 'bad' })).expect(400);
  });

  it('uses registration date when there is no user state and validates content', async () => {
    await Release.collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(),
        title: '',
        text: 'old',
        isPublished: true,
        publishedAt: new Date('2019-01-01T00:00:00.000Z'),
        createdAt: new Date('2019-01-01T00:00:00.000Z'),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        title: '',
        text: 'new',
        isPublished: true,
        publishedAt: new Date('2021-01-01T00:00:00.000Z'),
        createdAt: new Date('2021-01-01T00:00:00.000Z'),
      },
    ]);
    const status = await asUser(request(app).get('/api/releases/status')).expect(200);
    expect(status.body.unreadCount).toBe(1);
    const unread = await asUser(request(app).get('/api/releases/unread')).expect(200);
    expect(unread.body.items.map((item) => item.text)).toEqual(['new']);
    await asAdmin(request(app).post('/api/admin/releases').send({ text: ' ' })).expect(400);
    await asAdmin(
      request(app)
        .post('/api/admin/releases')
        .send({ text: 'x'.repeat(10001) }),
    ).expect(400);
    await asAdmin(
      request(app)
        .post('/api/admin/releases')
        .send({ title: 'x'.repeat(121), text: 'ok' }),
    ).expect(400);
    await asUser(request(app).get('/api/releases').query({ limit: 100 })).expect(400);
  });

  it('removes a published release from the unread count after deletion', async () => {
    const created = await asAdmin(
      request(app).post('/api/admin/releases').send({ text: 'to delete' }),
    ).expect(201);
    const id = created.body.release._id;
    await asAdmin(request(app).post(`/api/admin/releases/${id}/publish`)).expect(200);
    expect(
      (await asUser(request(app).get('/api/releases/status')).expect(200)).body.unreadCount,
    ).toBe(1);
    await asAdmin(request(app).delete(`/api/admin/releases/${id}`)).expect(200);
    expect(
      (await asUser(request(app).get('/api/releases/status')).expect(200)).body.unreadCount,
    ).toBe(0);
  });
});
