// index.js (with groups listing and selection feature)
const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const multer = require("multer");
const {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 21129;

if (!fs.existsSync("temp")) fs.mkdirSync("temp");
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const upload = multer({ dest: "uploads/" });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- SESSION MANAGEMENT ---
const activeClients = new Map();
const activeTasks = new Map();

function safeDeleteFile(p) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { }
}

function generateDisplayCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// --- GET USER SESSIONS ---
app.get("/user-sessions", (req, res) => {
    const ownerId = req.query.ownerId;
    if (!ownerId) {
        return res.status(400).json({ error: "Owner ID is required" });
    }

    const userSessions = [...activeClients.entries()]
        .filter(([_, info]) => info.ownerId === ownerId)
        .map(([id, info]) => ({
            sessionId: id,
            number: info.number,
            registered: info.registered,
            pairingCode: info.pairingCode || "WAITING...",
            isConnecting: info.isConnecting || false,
            deviceInfo: info.deviceInfo || null,
            pairedAt: info.pairedAt || null,
            groups: info.groups || [],
            totalGroups: info.groups ? info.groups.length : 0
        }));

    res.json({
        sessions: userSessions,
        total: userSessions.length
    });
});

// --- GET GROUPS FOR SESSION ---
app.get("/groups", async (req, res) => {
    const { sessionId, ownerId } = req.query;
    
    if (!sessionId || !ownerId) {
        return res.status(400).json({ error: "Session ID and Owner ID are required" });
    }

    if (!activeClients.has(sessionId)) {
        return res.status(404).json({ error: "Session not found" });
    }

    const sessionInfo = activeClients.get(sessionId);
    
    // CHECK OWNERSHIP
    if (sessionInfo.ownerId !== ownerId) {
        return res.status(403).json({ error: "Access denied. This session does not belong to you." });
    }

    if (!sessionInfo.registered || sessionInfo.isConnecting) {
        return res.status(400).json({ error: "Session not ready. Please wait for connection." });
    }

    try {
        // If groups are already cached and less than 5 minutes old, return them
        if (sessionInfo.groups && sessionInfo.groupsLastFetched) {
            const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
            if (sessionInfo.groupsLastFetched > fiveMinutesAgo) {
                return res.json({
                    success: true,
                    groups: sessionInfo.groups,
                    total: sessionInfo.groups.length,
                    cached: true
                });
            }
        }

        const { client: waClient } = sessionInfo;
        
        if (!waClient) {
            return res.status(400).json({ error: "Client not initialized" });
        }

console.log(`📋 Fetching groups for session: ${sessionId}`);
        
        // Fetch groups from WhatsApp
        const groupData = await waClient.groupFetchAllParticipating();
        
        const groups = Object.values(groupData).map(group => ({
            id: group.id,
            name: group.subject || 'Unknown Group',
            participants: group.participants ? group.participants.length : 0,
            isAnnouncement: group.announcement || false,
            isLocked: group.locked || false,
            creation: group.creation ? new Date(group.creation * 1000).toISOString() : null,
            subjectOwner: group.subjectOwner,
            subjectTime: group.subjectTime ? new Date(group.subjectTime * 1000).toISOString() : null
        })).sort((a, b) => a.name.localeCompare(b.name));

        // Cache the groups
        sessionInfo.groups = groups;
        sessionInfo.groupsLastFetched = Date.now();

        console.log(✅ Found ${groups.length} groups for ${sessionInfo.number});

        res.json({
            success: true,
            groups: groups,
            total: groups.length,
            cached: false
        });

    } catch (error) {
        console.error(❌ Error fetching groups for ${sessionId}:, error);
        res.status(500).json({ 
            error: "Failed to fetch groups: " + (error.message || "Unknown error"),
            details: "Make sure the WhatsApp session is properly connected"
        });
    }
});

// --- REFRESH GROUPS ---
app.post("/refresh-groups", upload.none(), async (req, res) => {
    const { sessionId, ownerId } = req.body;
    
    if (!sessionId || !ownerId) {
        return res.status(400).json({ error: "Session ID and Owner ID are required" });
    }

    if (!activeClients.has(sessionId)) {
        return res.status(404).json({ error: "Session not found" });
    }

    const sessionInfo = activeClients.get(sessionId);
    
    // CHECK OWNERSHIP
    if (sessionInfo.ownerId !== ownerId) {
        return res.status(403).json({ error: "Access denied. This session does not belong to you." });
    }

    if (!sessionInfo.registered || sessionInfo.isConnecting) {
        return res.status(400).json({ error: "Session not ready. Please wait for connection." });
    }

    try {
        const { client: waClient } = sessionInfo;
        
        if (!waClient) {
            return res.status(400).json({ error: "Client not initialized" });
        }

        console.log(🔄 Refreshing groups for session: ${sessionId});
        
        // Clear cache and fetch fresh groups
        sessionInfo.groups = null;
        sessionInfo.groupsLastFetched = null;
        
        const groupData = await waClient.groupFetchAllParticipating();
        
        const groups = Object.values(groupData).map(group => ({
            id: group.id,
            name: group.subject || 'Unknown Group',
            participants: group.participants ? group.participants.length : 0,
            isAnnouncement: group.announcement || false,
            isLocked: group.locked || false,
            creation: group.creation ? new Date(group.creation * 1000).toISOString() : null,
            subjectOwner: group.subjectOwner,
            subjectTime: group.subjectTime ? new Date(group.subjectTime * 1000).toISOString() : null
        })).sort((a, b) => a.name.localeCompare(b.name));

        // Cache the groups
        sessionInfo.groups = groups;
        sessionInfo.groupsLastFetched = Date.now();

        console.log(✅ Refreshed ${groups.length} groups for ${sessionInfo.number});

        res.json({
            success: true,
            groups: groups,
            total: groups.length,
            message: Successfully refreshed ${groups.length} groups
        });

    } catch (error) {
        console.error(❌ Error refreshing groups for ${sessionId}:, error);
        res.status(500).json({ 
            error: "Failed to refresh groups: " + (error.message || "Unknown error")
        });
    }
});

// --- PAIR NEW NUMBER ---
app.get("/code", async (req, res) => {
    const num = req.query.number?.replace(/[^0-9]/g, "");
    const ownerId = req.query.ownerId;
    
    if (!num) return res.status(400).json({ error: "Invalid number" });
    if (!ownerId) return res.status(400).json({ error: "Owner ID is required" });

    const sessionId = session_${num}_${ownerId};
    const sessionPath = path.join("temp", sessionId);
    
    const existingSession = activeClients.get(sessionId);
    if (existingSession) {
        if (existingSession.isConnecting) {
            return res.status(400).json({ error: "Session is already being set up. Please wait." });
        }
        if (existingSession.registered) {
            return res.json({ 
                pairingCode: existingSession.pairingCode || "CONNECTED",
                waCode: "ALREADY_CONNECTED", 
                sessionId: sessionId,
                status: "already-registered",
                message: "Session already registered and ready to use",
                deviceInfo: existingSession.deviceInfo,
                groups: existingSession.groups || [],
                totalGroups: existingSession.groups ? existingSession.groups.length : 0
            });
        }
    }

    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        if (state.creds?.registered) {
            const displayCode = generateDisplayCode();
            
            // Fetch groups for already registered session
            let groups = [];
            try {
                const waClient = makeWASocket({
                    version,
                    auth: {
                        creds: state.creds,
                        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
                    },
                    printQRInTerminal: false,
                    logger: pino({ level: "silent" }),
                    browser: Browsers.ubuntu('Chrome'),
                    syncFullHistory: false,
                });

                const groupData = await waClient.groupFetchAllParticipating();
                groups = Object.values(groupData).map(group => ({
                    id: group.id,
                    name: group.subject || 'Unknown Group',
                    participants: group.participants ? group.participants.length : 0,
                    isAnnouncement: group.announcement || false,
                    isLocked: group.locked || false
                })).sort((a, b) => a.name.localeCompare(b.name));

                waClient.end();
            } catch (groupError) {
                console.log("⚠️ Could not fetch groups for existing session:", groupError.message);
            }

            const sessionInfo = {
                client: null,
                number: num,
                authPath: sessionPath,
                registered: true,
                pairingCode: displayCode,
                ownerId,
                isConnecting: false,
                deviceInfo: {
                    platform: "WhatsApp Web",
                    pairedAt: new Date().toISOString(),
                    browser: "Chrome"
                },
                pairedAt: new Date(),
                groups: groups,
                groupsLastFetched: Date.now()
            };
            
            activeClients.set(sessionId, sessionInfo);
            
            return res.json({ 
                pairingCode: displayCode,
                waCode: "ALREADY_REGISTERED", 
                sessionId: sessionId,
                status: "already-registered",
                message: "Session already registered and ready to use",
                deviceInfo: sessionInfo.deviceInfo,
                groups: groups,
                totalGroups: groups.length
            });
        }

        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
            },
            printQRInTerminal: true,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
        });

        const displayCode = generateDisplayCode();
        const sessionInfo = {
            client: waClient,
            number: num,
            authPath: sessionPath,
            registered: false,
            pairingCode: displayCode,
            ownerId,
            isConnecting: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 3,
            deviceInfo: null,
            pairedAt: null,
            groups: [],
            groupsLastFetched: null
        };

        activeClients.set(sessionId, sessionInfo);

        let connectionTimeout;
        let isResolved = false;

        const resolveRequest = (data) => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(connectionTimeout);
            sessionInfo.isConnecting = false;
            res.json(data);
        };

        const rejectRequest = (error) => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(connectionTimeout);
            sessionInfo.isConnecting = false;
            res.status(500).json({ error });
        };

        connectionTimeout = setTimeout(() => {
            if (!isResolved) {
                console.log(⏰ Connection timeout for ${sessionId});
                rejectRequest("Connection timeout. Please try again.");
            }
        }, 120000);

        waClient.ev.on("creds.update", saveCreds);
        
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log(🔗 Connection update for ${sessionId}: ${connection});
            
            if (connection === "open") {
                console.log(✅ WhatsApp Connected for ${num}! (Session: ${sessionId}));
                
                // CAPTURE DEVICE INFO IMMEDIATELY AFTER PAIRING
                try {
                    const user = waClient.user;
                    const deviceInfo = {
                        platform: user?.platform || "WhatsApp Web",
                        pairedAt: new Date().toISOString(),
                        browser: "Chrome",
                        phoneNumber: user?.id?.split(':')[0] || num,
                        deviceType: "Browser",
                        connection: "Active"
                    };
                    
                    sessionInfo.deviceInfo = deviceInfo;
                    sessionInfo.pairedAt = new Date();
                } catch (deviceErr) {
                    console.log("⚠️ Could not capture device info:", deviceErr);
                    sessionInfo.deviceInfo = {
                        platform: "WhatsApp Web",
                        pairedAt: new Date().toISOString(),
                        browser: "Chrome",
                        phoneNumber: num,
                        deviceType: "Unknown"
                    };
                }
                
                // FETCH GROUPS IMMEDIATELY AFTER CONNECTION
                try {
                    console.log(📋 Fetching groups for newly connected session: ${sessionId});
                    const groupData = await waClient.groupFetchAllParticipating();
                    
                    const groups = Object.values(groupData).map(group => ({
                        id: group.id,
                        name: group.subject || 'Unknown Group',
                        participants: group.participants ? group.participants.length : 0,
                        isAnnouncement: group.announcement || false,
                        isLocked: group.locked || false,
                        creation: group.creation ? new Date(group.creation * 1000).toISOString() : null
                    })).sort((a, b) => a.name.localeCompare(b.name));
                    
                    sessionInfo.groups = groups;
                    sessionInfo.groupsLastFetched = Date.now();
                    
                    console.log(✅ Found ${groups.length} groups for ${num});
                } catch (groupError) {
                    console.log("⚠️ Could not fetch groups after connection:", groupError.message);
                    sessionInfo.groups = [];
                }
                
                sessionInfo.registered = true;
                sessionInfo.isConnecting = false;
                sessionInfo.reconnectAttempts = 0;
                
                if (!isResolved) {
                    resolveRequest({ 
                        pairingCode: "CONNECTED",
                        waCode: "CONNECTED",
                        sessionId: sessionId,
                        status: "connected",
                        message: "WhatsApp connected successfully!",
                        deviceInfo: sessionInfo.deviceInfo,
                        groups: sessionInfo.groups || [],
                        totalGroups: sessionInfo.groups ? sessionInfo.groups.length : 0
                    });
                }
            } 
            else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(❌ Connection closed for ${sessionId}, status: ${statusCode});
                
                if (statusCode === 401) {
                    console.log(🚫 Auth error for ${sessionId});
                    sessionInfo.registered = false;
                    sessionInfo.isConnecting = false;
                    sessionInfo.deviceInfo = null;
                    sessionInfo.pairedAt = null;
                    sessionInfo.groups = [];
                    if (!isResolved) {
                        rejectRequest("Authentication failed. Please pair again.");
                    }
                } else {
                    sessionInfo.reconnectAttempts++;
                    if (sessionInfo.reconnectAttempts <= sessionInfo.maxReconnectAttempts) {
                        console.log(🔄 Reconnection attempt ${sessionInfo.reconnectAttempts} for ${sessionId} in 5s...);
                        setTimeout(() => {
                            if (activeClients.has(sessionId)) {
                                initializeClient(sessionId, sessionInfo);
                            }
                        }, 5000);
                    } else {
                        console.log(🚫 Max reconnection attempts reached for ${sessionId});
                        sessionInfo.isConnecting = false;
                        if (!isResolved) {
                            rejectRequest("Max reconnection attempts reached. Please try again.");
                        }
                    }
                }
            }
            
            if (qr && !isResolved) {
                console.log(📱 QR code received for ${sessionId});
                
                let actualPairingCode = null;
                
                try {
                    console.log(🔄 Attempting to get pairing code via API...);
                    actualPairingCode = await waClient.requestPairingCode(num);
                    if (actualPairingCode) {
                        console.log(✅ Got pairing code via API: ${actualPairingCode});
                    }
                } catch (apiError) {
                    console.log(❌ API method failed:, apiError.message);
                }
                
                if (!actualPairingCode && qr) {
                    try {
                        const qrMatch = qr.match(/[A-Z0-9]{6,8}/);
                        if (qrMatch) {
                            actualPairingCode = qrMatch[0];
                            console.log(✅ Extracted pairing code from QR: ${actualPairingCode});
                        }
                    } catch (qrError) {
                        console.log(❌ QR extraction failed:, qrError.message);
                    }
                }
                
                if (!actualPairingCode && qr && qr.length >= 6 && qr.length <= 8) {
                    actualPairingCode = qr;
                    console.log(✅ Using QR as pairing code: ${actualPairingCode});
                }
                
                if (actualPairingCode) {
                    sessionInfo.pairingCode = actualPairingCode;
                    
                    resolveRequest({ 
                        pairingCode: actualPairingCode,
                        waCode: actualPairingCode,
                        sessionId: sessionId,
                        status: "code_received", 
                        message: Use this code in WhatsApp Linked Devices: ${actualPairingCode}
                    });
                } else {
                    resolveRequest({ 
                        pairingCode: sessionInfo.pairingCode,
                        waCode: qr,
                        sessionId: sessionId,
                        status: "qr_received", 
                        message: "Scan the QR code with WhatsApp"
                    });
                }
            }
        });

        setTimeout(async () => {
            if (!isResolved) {
                try {
                    console.log(🔄 Trying to get pairing code directly...);
                    const pairingCode = await waClient.requestPairingCode(num);
                    if (pairingCode) {
                        console.log(✅ Got pairing code directly: ${pairingCode});
                        sessionInfo.pairingCode = pairingCode;
                        
                        resolveRequest({ 
                            pairingCode: pairingCode,
                            waCode: pairingCode,
                            sessionId: sessionId,
                            status: "code_received", 
                            message: Use code in WhatsApp: ${pairingCode}
                        });
                    }
                } catch (error) {
                    console.log(ℹ️ Direct pairing code not available yet:, error.message);
                }
            }
        }, 3000);

    } catch (err) {
        console.error("❌ Session creation error:", err);
        activeClients.delete(sessionId);
        return res.status(500).json({ error: err.message || "Server error" });
    }
});

async function initializeClient(sessionId, sessionInfo) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionInfo.authPath);
        const { version } = await fetchLatestBaileysVersion();

        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
        });

        sessionInfo.client = waClient;
        sessionInfo.isConnecting = true;

        waClient.ev.on("creds.update", saveCreds);
        
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === "open") {
                console.log(🔄 Reconnected for ${sessionId});
                
                // UPDATE DEVICE INFO ON RECONNECTION
                try {
                    const user = waClient.user;
                    sessionInfo.deviceInfo = {
                        platform: user?.platform || "WhatsApp Web",
                        pairedAt: sessionInfo.pairedAt || new Date().toISOString(),
                        browser: "Chrome",
                        phoneNumber: user?.id?.split(':')[0] || sessionInfo.number,
                        deviceType: "Browser",
                        connection: "Reconnected",
                        lastSeen: new Date().toISOString()
                    };
                    
                    // REFRESH GROUPS ON RECONNECTION
                    try {
                        console.log(🔄 Refreshing groups on reconnection for: ${sessionId});
                        const groupData = await waClient.groupFetchAllParticipating();
                        const groups = Object.values(groupData).map(group => ({
                            id: group.id,
                            name: group.subject || 'Unknown Group',
                            participants: group.participants ? group.participants.length : 0,
                            isAnnouncement: group.announcement || false,
                            isLocked: group.locked || false
                        })).sort((a, b) => a.name.localeCompare(b.name));
                        
                        sessionInfo.groups = groups;
                        sessionInfo.groupsLastFetched = Date.now();
                        console.log(✅ Refreshed ${groups.length} groups on reconnection);
                    } catch (groupError) {
                        console.log("⚠️ Could not refresh groups on reconnection:", groupError.message);
                    }
                    
                } catch (e) {
                    console.log("⚠️ Could not update device info on reconnect");
                }
                
                sessionInfo.registered = true;
                sessionInfo.isConnecting = false;
                sessionInfo.reconnectAttempts = 0;
            } 
            else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(Reconnection closed for ${sessionId}, status: ${statusCode});
                
                if (statusCode === 401) {
                    console.log(Auth failed for ${sessionId});
                    sessionInfo.registered = false;
                    sessionInfo.isConnecting = false;
                    sessionInfo.deviceInfo = null;
                } else {
                    sessionInfo.reconnectAttempts++;
                    if (sessionInfo.reconnectAttempts <= sessionInfo.maxReconnectAttempts) {
                        setTimeout(() => {
                            if (activeClients.has(sessionId)) {
                                initializeClient(sessionId, sessionInfo);
                            }
                        }, 5000);
                    } else {
                        console.log(Max reconnection attempts reached for ${sessionId});
                        sessionInfo.isConnecting = false;
                    }
                }
            }
        });

    } catch (err) {
        console.error(Reconnection failed for ${sessionId}, err);
        sessionInfo.isConnecting = false;
    }
}

// --- SEND MESSAGE ---
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
    const { sessionId, target, targetType, delaySec, prefix, ownerId, groupId } = req.body;
    const filePath = req.file?.path;

    if (!sessionId || !activeClients.has(sessionId)) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Invalid or inactive sessionId" });
    }
    
    const sessionInfo = activeClients.get(sessionId);
    
    // CHECK IF SESSION BELONGS TO THE USER
    if (ownerId && sessionInfo.ownerId !== ownerId) {
        safeDeleteFile(filePath);
        return res.status(403).json({ error: "Access denied. This session does not belong to you." });
    }
    
    if (!sessionInfo.registered || sessionInfo.isConnecting) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Session not ready. Please wait for connection." });
    }

    if (!sessionInfo.client && sessionInfo.registered) {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionInfo.authPath);
            const { version } = await fetchLatestBaileysVersion();

            const waClient = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.ubuntu('Chrome'),
                syncFullHistory: false,
            });

            sessionInfo.client = waClient;
            waClient.ev.on("creds.update", saveCreds);
            
            await new Promise((resolve) => {
                waClient.ev.on("connection.update", (update) => {
                    if (update.connection === "open") {
                        resolve();
                    }
                });
            });
            
        } catch (err) {
            safeDeleteFile(filePath);
            return res.status(400).json({ error: "Failed to initialize session: " + err.message });
        }
    }

    if ((!target && !groupId) || !filePath || !targetType || !delaySec) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Missing required fields" });
    }

    const { client: waClient } = sessionInfo;
    
    // Use groupId if provided, otherwise use target
    let finalTarget = target;
    if (groupId && targetType === "group") {
        finalTarget = groupId;
    }
    
    if (!finalTarget) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "No target specified" });
    }

    // SIMPLE TASK ID - Easy to remember and use for stopping
    const taskId = TASK_${Date.now()};

    let messages;
    try {
        messages = fs.readFileSync(filePath, "utf-8").split("\n").map(m => m.trim()).filter(Boolean);
        if (messages.length === 0) throw new Error("Message file empty");
    } catch (err) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Invalid message file" });
    }

    const taskInfo = {
        taskId,
        sessionId,
        ownerId: ownerId || sessionInfo.ownerId,
        isSending: true,
        stopRequested: false,
        totalMessages: messages.length,
        sentMessages: 0,
        target: finalTarget,
        targetType,
        prefix: prefix || "",
        startTime: new Date(),
        lastUpdate: new Date(),
        groupId: groupId || null
    };

    activeTasks.set(taskId, taskInfo);
    
    // RETURN TASK ID CLEARLY - This is what you need to stop the task
    res.json({ 
        success: true,
        taskId: taskId,
        status: "started", 
        totalMessages: messages.length,
        message: 📨 Task STARTED! Use this ID to stop: ${taskId}
    });

    console.log(🚀 Task STARTED: ${taskId});
    console.log(📝 Messages: ${messages.length});
    console.log(🎯 Target: ${finalTarget});
    console.log(📋 Target Type: ${targetType});
    console.log(⏰ Delay: ${delaySec}s);
    console.log(👤 Owner: ${taskInfo.ownerId});
    console.log(🛑 STOP COMMAND: curl -X POST http://localhost:${PORT}/stop-task -d "taskId=${taskId}");

    // Task execution
    (async () => {
        try {
            for (let index = 0; index < messages.length && !taskInfo.stopRequested; index++) {
                try {
                    let msg = messages[index];
                    if (taskInfo.prefix) msg = ${taskInfo.prefix} ${msg};
                    
                    const recipient = taskInfo.targetType === "group"
                        ? (taskInfo.target.includes('@g.us') ? taskInfo.target : taskInfo.target + '@g.us')
                        : (taskInfo.target.includes('@s.whatsapp.net') ? taskInfo.target : taskInfo.target + '@s.whatsapp.net');

                    await waClient.sendMessage(recipient, { text: msg });

                    taskInfo.sentMessages++;
                    taskInfo.lastUpdate = new Date();
                    
                    // Show progress every 10 messages
                    if (taskInfo.sentMessages % 10 === 0 || taskInfo.sentMessages === taskInfo.totalMessages) {
                        console.log([${taskId}] Progress: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent);
                    }
                    
                } catch (sendErr) {
                    console.error([${taskId}] Send error:, sendErr);
                    taskInfo.error = sendErr?.message || String(sendErr);
                    taskInfo.lastError = new Date();
                    
                    if (sendErr.message?.includes("closed") || sendErr.message?.includes("disconnected")) {
                        taskInfo.stopRequested = true;
                        taskInfo.error = "Session disconnected. Please reconnect.";
                    }
                }

                const waitMs = parseFloat(delaySec) * 1000;
                const chunks = Math.ceil(waitMs / 1000);
                for (let t = 0; t < chunks && !taskInfo.stopRequested; t++) {
                    await delay(1000);
                }
                
                if (taskInfo.stopRequested) break;
            }
        } finally {
            taskInfo.endTime = new Date();
            taskInfo.isSending = false;
            taskInfo.completed = !taskInfo.stopRequested;
            safeDeleteFile(filePath);
            
            const status = taskInfo.stopRequested ? "STOPPED" : "COMPLETED";
            console.log([${taskId}] ${status}: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent);
            
            // Keep task in memory for 10 minutes for status checking
            setTimeout(() => {
                if (activeTasks.has(taskId)) {
                    activeTasks.delete(taskId);
                    console.log([${taskId}] Removed from memory);
                }
            }, 600000);
        }
    })();
});

// --- TASK STATUS ---
app.get("/task-status", (req, res) => {
    const taskId = req.query.taskId;
    const ownerId = req.query.ownerId;
    
    if (!taskId) return res.status(400).json({ error: "Task ID is required" });
    
    if (!activeTasks.has(taskId)) {
        return res.status(404).json({ error: "Task not found. It may be completed or never existed." });
    }

    const taskInfo = activeTasks.get(taskId);
    
    // CHECK OWNERSHIP
    if (ownerId && taskInfo.ownerId !== ownerId) {
        return res.status(403).json({ error: "Access denied. This task does not belong to you." });
    }

    res.json({
        taskId: taskInfo.taskId,
        status: taskInfo.isSending ? "sending" : (taskInfo.stopRequested ? "stopped" : "completed"),
        sentMessages: taskInfo.sentMessages,
        totalMessages: taskInfo.totalMessages,
        progress: Math.round((taskInfo.sentMessages / taskInfo.totalMessages) * 100),
        startTime: taskInfo.startTime,
        endTime: taskInfo.endTime,
        error: taskInfo.error
    });
});

// --- USER TASKS ---
app.get("/user-tasks", (req, res) => {
    const ownerId = req.query.ownerId;
    if (!ownerId) return res.status(400).json({ error: "Owner ID is required" });

    const userTasks = [...activeTasks.entries()]
        .filter(([_, task]) => task.ownerId === ownerId)
        .map(([id, task]) => ({
            taskId: id,
            sessionId: task.sessionId,
            isSending: task.isSending,
            sentMessages: task.sentMessages,
            totalMessages: task.totalMessages,
            startTime: task.startTime,
            target: task.target,
            progress: Math.round((task.sentMessages / task.totalMessages) * 100)
        }));
    
    res.json({ 
        tasks: userTasks,
        total: userTasks.length
    });
});

// --- STOP TASK ---
app.post("/stop-task", upload.none(), async (req, res) => {
    const { taskId, ownerId } = req.body;
    
    if (!taskId) {
        return res.status(400).json({ error: "Task ID is required. Example: taskId=TASK_123456789" });
    }
    
    if (!activeTasks.has(taskId)) {
        return res.status(404).json({ error: Task ${taskId} not found. It may be already completed or never existed. });
    }

    const taskInfo = activeTasks.get(taskId);
    
    // CHECK OWNERSHIP
    if (ownerId && taskInfo.ownerId !== ownerId) {
        return res.status(403).json({ error: "Access denied. This task does not belong to you." });
    }
    
    if (!taskInfo.isSending) {
        return res.json({ 
            success: true, 
            message: Task ${taskId} is already ${taskInfo.stopRequested ? 'stopped' : 'completed'} 
        });
    }
    
    taskInfo.stopRequested = true;
    taskInfo.isSending = false;
    taskInfo.endTime = new Date();
    taskInfo.endedBy = "user";

    console.log(🛑 Task STOPPED: ${taskId});
    console.log(📊 Final progress: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent);

    return res.json({ 
        success: true, 
        message: Task ${taskId} stopped successfully,
        taskId: taskId,
        sentMessages: taskInfo.sentMessages,
        totalMessages: taskInfo.totalMessages,
        progress: Math.round((taskInfo.sentMessages / taskInfo.totalMessages) * 100)
    });
});

// --- DELETE SESSION ---
app.post("/delete-session", upload.none(), async (req, res) => {
    const { sessionId, ownerId } = req.body;
    
    if (!sessionId) return res.status(400).json({ error: "Session ID is required" });
    if (!ownerId) return res.status(400).json({ error: "Owner ID is required" });
    
    if (!activeClients.has(sessionId)) {
        return res.status(404).json({ error: "Session not found" });
    }

    const sessionInfo = activeClients.get(sessionId);
    
    // CHECK OWNERSHIP
    if (sessionInfo.ownerId !== ownerId) {
        return res.status(403).json({ error: "Access denied. This session does not belong to you." });
    }

    try {
        if (sessionInfo.client) {
            sessionInfo.client.end();
            console.log(🔌 Disconnected client for session: ${sessionId});
        }
        
        // Delete session files
        if (sessionInfo.authPath && fs.existsSync(sessionInfo.authPath)) {
            fs.rmSync(sessionInfo.authPath, { recursive: true, force: true });
            console.log(🗑️ Deleted session files: ${sessionInfo.authPath});
        }
        
        activeClients.delete(sessionId);
        console.log(✅ Session deleted: ${sessionId});
        
        res.json({ 
            success: true, 
            message: Session ${sessionId} deleted successfully 
        });
        
    } catch (err) {
        console.error(❌ Error deleting session ${sessionId}:, err);
        res.status(500).json({ error: "Failed to delete session" });
    }
});

// --- CLEANUP ENDPOINT ---
app.post("/cleanup-session", upload.none(), async (req, res) => {
    const { sessionId, ownerId } = req.body;
    
    if (sessionId === "all") {
        // Only clean up sessions belonging to the specific owner
        if (ownerId) {
            let cleanedCount = 0;
            activeClients.forEach((sessionInfo, id) => {
                if (sessionInfo.ownerId === ownerId) {
                    try {
                        if (sessionInfo.client) sessionInfo.client.end();
                        console.log(🧹 Session cleaned up: ${id});
                        activeClients.delete(id);
                        cleanedCount++;
                    } catch (e) {
                        console.error(Error cleaning up session ${id}:, e);
                    }
                }
            });
            return res.json({ success: true, message: Cleaned up ${cleanedCount} sessions for owner ${ownerId} });
        } else {
            // Clean all sessions (admin function)
            activeClients.forEach((sessionInfo, id) => {
                try {
                    if (sessionInfo.client) sessionInfo.client.end();
                    console.log(🧹 Session cleaned up: ${id});
                } catch (e) {
                    console.error(Error cleaning up session ${id}:, e);
                }
            });
            activeClients.clear();
        }
    }
    
    res.json({ success: true, message: "Sessions cleaned up" });
});

process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    activeClients.forEach(({ client }, sessionId) => {
        try { 
            if (client) client.end(); 
            console.log(Closed session: ${sessionId});
        } catch (e) { 
            console.error(Error closing session ${sessionId}:, e);
        }
    });
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(🚀 Server running at http://localhost:${PORT});
    console.log(📱 WhatsApp Bulk Sender Ready!);
    console.log(🔐 User-specific sessions enabled);
    console.log(📟 Device pairing feature activated);
    console.log(👥 Group listing and selection feature added);
});

