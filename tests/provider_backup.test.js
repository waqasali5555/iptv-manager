
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as streamController from '../src/controllers/streamController.js';
import { Readable } from 'node:stream';

// Mocks
const { mockDb, mockFetch, mockProviderPoolAll, mockFfmpeg, mockFfmpegCommand } = vi.hoisted(() => {
    const mockFfmpegCommand = {
        inputFormat: vi.fn().mockReturnThis(),
        outputOptions: vi.fn().mockReturnThis(),
        on: vi.fn().mockReturnThis(),
        pipe: vi.fn()
    };
    return {
        mockDb: {
            prepare: vi.fn(),
            exec: vi.fn(),
            pragma: vi.fn(),
        },
        mockFetch: vi.fn(),
        mockProviderPoolAll: vi.fn(),
        mockFfmpeg: vi.fn(() => mockFfmpegCommand),
        mockFfmpegCommand
    };
});

vi.mock('../src/database/db.js', () => ({
    default: mockDb
}));

vi.mock('node-fetch', () => ({
    default: mockFetch
}));

vi.mock('../src/services/streamManager.js', () => ({
    default: {
        isSessionActive: vi.fn().mockResolvedValue(false),
        getUserConnectionCount: vi.fn().mockResolvedValue(0),
        getProviderConnectionCount: vi.fn().mockResolvedValue(0),
        add: vi.fn(),
        remove: vi.fn(),
        cleanupUser: vi.fn(),
        localStreams: new Map()
    }
}));

vi.mock('../src/services/authService.js', () => ({
    getXtreamUser: vi.fn(async () => ({ id: 1, username: 'testuser', is_share_guest: false }))
}));

vi.mock('../src/utils/helpers.js', async importOriginal => ({
  ...(await importOriginal()),
    redactUrl: vi.fn(url => url),
    getBaseUrl: vi.fn(() => 'http://localhost:3000'),
    isSafeUrl: vi.fn(async () => true),
    safeLookup: vi.fn((hostname, options, cb) => cb(null, '127.0.0.1', 4)),
    providerSourceKey: vi.fn((url) => String(url || ''))
}));

vi.mock('../src/utils/crypto.js', () => ({
    decrypt: vi.fn((val) => val),
    encrypt: vi.fn((val) => 'enc:' + val)
}));

vi.mock('../src/config/constants.js', () => ({
    DEFAULT_USER_AGENT: 'TestAgent',
    BCRYPT_ROUNDS: 1,
    DATA_DIR: '/tmp',
    EPG_CACHE_DIR: '/tmp/epg'
}));

// Mock fluent-ffmpeg module
vi.mock('fluent-ffmpeg', () => ({
    default: mockFfmpeg
}));

describe('Stream Controller - Backup Failover', () => {
    let mockReq, mockRes;
    let channelRow;

    beforeEach(() => {
        vi.clearAllMocks();
        channelRow = {
            user_channel_id: 1,
            provider_channel_id: 10,
            provider_id: 100,
            remote_stream_id: 555,
            name: 'Test Channel',
            metadata: '{}',
            provider_url: 'http://primary.com',
            provider_user: 'user',
            provider_pass: 'pass',
            provider_max_connections: 10,
            backup_urls: JSON.stringify(['http://backup1.com', 'http://backup2.com'])
        };
        mockProviderPoolAll.mockReturnValue([{
            id: 100,
            user_id: 1,
            url: 'http://primary.com',
            username: 'user',
            password: 'pass',
            max_connections: 10,
            backup_urls: JSON.stringify(['http://backup1.com', 'http://backup2.com'])
        }]);
        mockReq = {
            params: { stream_id: '123', username: 'u', password: 'p' },
            query: {},
            path: '/live/u/p/123.ts',
            headers: {},
            ip: '127.0.0.1',
            on: vi.fn()
        };
        mockRes = {
            sendStatus: vi.fn(),
            setHeader: vi.fn(),
            status: vi.fn(),
            send: vi.fn(),
            headersSent: false
        };

        // Mock DB prepare to handle different queries
        mockDb.prepare.mockImplementation((query) => {
            if (query.trim().startsWith('SELECT') && query.includes('user_channels uc')) {
                return {
                    get: vi.fn(() => channelRow)
                };
            }
            if (query.includes('FROM providers WHERE user_id = ? AND url LIKE ?')) {
                return {
                    all: mockProviderPoolAll
                };
            }
            // Stats or other queries
            return {
                get: vi.fn().mockReturnValue({ id: 99 }),
                run: vi.fn(),
                all: vi.fn().mockReturnValue([])
            };
        });
    });

    it('should use primary URL if it succeeds', async () => {
        const destroy = vi.fn();
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: { pipe: vi.fn(), on: vi.fn(), destroy }
        });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('FROM authorized_user_channels uc'));
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('http://primary.com'), expect.any(Object));
        expect(mockRes.sendStatus).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
    });

    it('uses the stored M3U URL for live playback', async () => {
        const originalUrl = 'https://cdn.example/live/channel.ts';
        channelRow.metadata = JSON.stringify({
            original_url: originalUrl,
            http_headers: { Referer: 'https://cdn.example/' }
        });
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: { pipe: vi.fn(), on: vi.fn(), destroy: vi.fn() }
        });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(originalUrl, expect.objectContaining({
            headers: expect.objectContaining({
                'User-Agent': 'TestAgent',
                Referer: 'https://cdn.example/'
            })
        }));
    });

    it('uses the stored M3U URL as the HLS manifest and preserves segment proxying', async () => {
        const originalUrl = 'https://cdn.example/live/index.m3u8';
        channelRow.metadata = JSON.stringify({ original_url: originalUrl });
        mockReq.path = '/live/u/p/123.m3u8';
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: Readable.from(['#EXTM3U\nsegment.ts\n'])
        });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(originalUrl, expect.any(Object));
        expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('/live/segment/u/p/seg.ts?'));
        expect(mockRes.send.mock.calls[0][0]).toContain(
            'https%3A%2F%2Fcdn.example%2Flive%2Fsegment.ts'
        );
    });

    it('keeps Xtream HLS playback on the provider-generated URL', async () => {
        mockReq.path = '/live/u/p/123.m3u8';
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: Readable.from(['#EXTM3U\nsegment.ts\n'])
        });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith('http://primary.com/live/user/pass/555.m3u8', expect.any(Object));
        expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('/live/segment/u/p/seg.ts?'));
        expect(mockRes.send.mock.calls[0][0]).toContain(
            'http%3A%2F%2Fprimary.com%2Flive%2Fuser%2Fpass%2Fsegment.ts'
        );
    });

    it('should keep an explicitly authorized source playable outside the user provider pool', async () => {
        mockProviderPoolAll.mockReturnValue([]);
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: { pipe: vi.fn(), on: vi.fn(), destroy: vi.fn() }
        });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('http://primary.com'), expect.any(Object));
        expect(mockRes.sendStatus).not.toHaveBeenCalled();
    });

    it('should transcode a transport stream to MP3 for radio clients', async () => {
        mockReq.path = '/live/u/p/123.mp3';
        mockReq.query.transcode = 'true';
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: { destroy: vi.fn() }
        });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/555.ts'), expect.any(Object));
        expect(mockFfmpegCommand.outputOptions).toHaveBeenCalledWith([
            '-vn',
            '-c:a libmp3lame',
            '-b:a 128k',
            '-f mp3'
        ]);
        expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'audio/mpeg');
    });

    it('should failover to first backup if primary fails', async () => {
        const destroy = vi.fn();
        // First call fails
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 503,
            body: { destroy }
        });
        // Second call succeeds
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: { pipe: vi.fn(), on: vi.fn() }
        });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('http://primary.com'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(2, expect.stringContaining('http://backup1.com'), expect.any(Object));
        expect(mockRes.sendStatus).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('should failover to second backup if first backup also fails', async () => {
        const primaryDestroy = vi.fn();
        const firstBackupDestroy = vi.fn();
        const successDestroy = vi.fn();
        mockFetch
            .mockResolvedValueOnce({ ok: false, status: 500, body: { destroy: primaryDestroy } }) // Primary
            .mockResolvedValueOnce({ ok: false, status: 404, body: { destroy: firstBackupDestroy } }) // Backup 1
            .mockResolvedValueOnce({ // Backup 2
                ok: true,
                status: 200,
                headers: { get: () => null },
                body: { pipe: vi.fn(), on: vi.fn(), destroy: successDestroy }
            });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(mockFetch).toHaveBeenLastCalledWith(expect.stringContaining('http://backup2.com'), expect.any(Object));
        expect(primaryDestroy).toHaveBeenCalledOnce();
        expect(firstBackupDestroy).toHaveBeenCalledOnce();
        expect(successDestroy).not.toHaveBeenCalled();
    });

    it('should return 502 if all URLs fail', async () => {
        const destroys = [];
        mockFetch.mockImplementation(async () => {
            const destroy = vi.fn();
            destroys.push(destroy);
            return { ok: false, status: 500, body: { destroy } };
        });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledTimes(3); // Primary + 2 backups
        expect(mockRes.sendStatus).toHaveBeenCalledWith(502);
        expect(destroys).toHaveLength(3);
        destroys.forEach(destroy => expect(destroy).toHaveBeenCalledOnce());
    });
});
