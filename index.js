const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Store active sessions
const sessions = new Map();

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize WhatsApp session
app.post('/api/init-session', async (req, res) => {
    const { sessionId } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
    }

    if (sessions.has(sessionId)) {
        return res.json({ 
            message: 'Session already exists', 
            status: 'connected',
            qrCode: null 
        });
    }

    try {
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: sessionId }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            }
        });

        let qrCodeData = null;

        client.on('qr', (qr) => {
            console.log(`QR Code received for session: ${sessionId}`);
            qrCodeData = qr;
            // Store QR code temporarily
            sessions.set(sessionId, { 
                client, 
                status: 'qr_received', 
                qrCode: qr,
                number: null
            });
        });

        client.on('ready', () => {
            console.log(`Client is ready for session: ${sessionId}`);
            const sessionInfo = sessions.get(sessionId);
            if (sessionInfo) {
                sessionInfo.status = 'connected';
                sessionInfo.number = client.info.wid.user;
                sessionInfo.qrCode = null;
            }
        });

        client.on('authenticated', () => {
            console.log(`Authenticated for session: ${sessionId}`);
        });

        client.on('auth_failure', (msg) => {
            console.log(`Authentication failure for session ${sessionId}:`, msg);
            sessions.delete(sessionId);
        });

        client.on('disconnected', (reason) => {
            console.log(`Client disconnected for session ${sessionId}:`, reason);
            sessions.delete(sessionId);
        });

        await client.initialize();
        
        sessions.set(sessionId, { 
            client, 
            status: 'initializing', 
            qrCode: qrCodeData,
            number: null
        });

        // Wait a bit for QR code generation
        await new Promise(resolve => setTimeout(resolve, 2000));

        const currentSession = sessions.get(sessionId);
        
        res.json({
            message: 'Session initialized',
            status: currentSession.status,
            qrCode: currentSession.qrCode,
            sessionId: sessionId
        });

    } catch (error) {
        console.error(`Error initializing session ${sessionId}:`, error);
        sessions.delete(sessionId);
        res.status(500).json({ error: 'Failed to initialize session' });
    }
});

// Get session status
app.get('/api/session-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        status: session.status,
        qrCode: session.qrCode,
        number: session.number,
        sessionId: sessionId
    });
});

// Get groups for a session
app.get('/api/groups/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const sessionInfo = sessions.get(sessionId);

    if (!sessionInfo) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (sessionInfo.status !== 'connected') {
        return res.status(400).json({ error: 'Session not connected' });
    }

    try {
        console.log(`📋 Fetching groups for session: ${sessionId}`);
        const client = sessionInfo.client;
        const chats = await client.getChats();
        const groups = chats.filter(chat => chat.isGroup);
        
        console.log(`✅ Found ${groups.length} groups for ${sessionInfo.number}`);
        
        const groupList = groups.map(group => ({
            id: group.id._serialized,
            name: group.name,
            participants: group.participants.length
        }));

        res.json({ groups: groupList });
    } catch (error) {
        console.error(`❌ Error fetching groups for session ${sessionId}:`, error);
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});

// Send bulk messages
app.post('/api/send-messages', async (req, res) => {
    const { sessionId, groupIds, message, delay = 1000 } = req.body;

    if (!sessionId || !groupIds || !message) {
        return res.status(400).json({ 
            error: 'Session ID, group IDs, and message are required' 
        });
    }

    const sessionInfo = sessions.get(sessionId);
    if (!sessionInfo) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (sessionInfo.status !== 'connected') {
        return res.status(400).json({ error: 'Session not connected' });
    }

    try {
        const client = sessionInfo.client;
        const results = [];
        const failed = [];

        console.log(`🚀 Starting bulk message send for ${groupIds.length} groups`);

        for (let i = 0; i < groupIds.length; i++) {
            const groupId = groupIds[i];
            
            try {
                console.log(`📤 Sending message to group ${i + 1}/${groupIds.length}`);
                
                await client.sendMessage(groupId, message);
                results.push({ groupId, status: 'success' });
                
                console.log(`✅ Message sent successfully to group ${i + 1}`);

                // Delay between messages
                if (i < groupIds.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, parseInt(delay)));
                }

            } catch (error) {
                console.error(`❌ Failed to send message to group ${groupId}:`, error);
                failed.push({ groupId, error: error.message });
                results.push({ groupId, status: 'failed', error: error.message });
            }
        }

        console.log(`🎉 Bulk send completed. Successful: ${results.length - failed.length}, Failed: ${failed.length}`);

        res.json({
            success: true,
            total: groupIds.length,
            successful: results.length - failed.length,
            failed: failed.length,
            results: results,
            failedGroups: failed
        });

    } catch (error) {
        console.error(`💥 Error in bulk send for session ${sessionId}:`, error);
        res.status(500).json({ 
            error: 'Failed to send bulk messages',
            details: error.message 
        });
    }
});

// Destroy session
app.delete('/api/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const sessionInfo = sessions.get(sessionId);

    if (!sessionInfo) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await sessionInfo.client.destroy();
        sessions.delete(sessionId);
        
        console.log(`🗑️ Session destroyed: ${sessionId}`);
        res.json({ message: 'Session destroyed successfully' });
    } catch (error) {
        console.error(`Error destroying session ${sessionId}:`, error);
        res.status(500).json({ error: 'Failed to destroy session' });
    }
});

// Get all active sessions
app.get('/api/sessions', (req, res) => {
    const sessionList = [];
    
    sessions.forEach((value, key) => {
        sessionList.push({
            sessionId: key,
            status: value.status,
            number: value.number
        });
    });

    res.json({ sessions: sessionList });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size 
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 WhatsApp Bulk Sender server running on port ${PORT}`);
    console.log(`📱 Access the application at: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down server...');
    
    for (const [sessionId, sessionInfo] of sessions) {
        try {
            await sessionInfo.client.destroy();
            console.log(`Closed session: ${sessionId}`);
        } catch (error) {
            console.error(`Error closing session ${sessionId}:`, error);
        }
    }
    
    console.log('👋 Server shut down successfully');
    process.exit(0);
});
