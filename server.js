const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Exa = require('exa-js').default;

// Config
const __dirname_fix = path.dirname(require.resolve('./package.json'));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname_fix, 'public')));
const config = JSON.parse(fs.readFileSync(path.join(__dirname_fix, 'config.json'), 'utf8'));
const parser = new Parser();

// Initialize Exa
const exa = config.exa_api_key ? new Exa(config.exa_api_key) : null;

// Data storage
const DATA_DIR = path.join(__dirname_fix, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json');
const CLAIMS_FILE = path.join(DATA_DIR, 'claims.json');

// Initialize data files
const initFile = (file, defaultData) => {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultData, null, 2));
};
initFile(SIGNALS_FILE, []);
initFile(AGENTS_FILE, {});
initFile(TASKS_FILE, { tasks: [], lastFetch: 0 });
initFile(MESSAGES_FILE, {});
initFile(REGISTRY_FILE, { agents: {}, apiKeys: {} });
initFile(CLAIMS_FILE, { claims: {}, history: [] });

// Load/save helpers
const loadData = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const saveData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// =============================================================================
// REWARD SYSTEM CONSTANTS
// =============================================================================
const GENESIS_TIERS = {
  FOUNDING: { max: 10, multiplier: 4 },    // Agent #1-10: 4x
  EARLY: { max: 50, multiplier: 3 },       // Agent #11-50: 3x
  GENESIS: { max: 100, multiplier: 2 },    // Agent #51-100: 2x
  NORMAL: { max: Infinity, multiplier: 1 } // Agent #101+: 1x
};

const STREAK_TIERS = {
  WEEK1: { days: 7, multiplier: 1 },       // Day 1-7: 1x
  WEEK2: { days: 14, multiplier: 1.2 },    // Day 8-14: 1.2x
  MONTH: { days: 30, multiplier: 1.5 },    // Day 15-30: 1.5x
  VETERAN: { days: Infinity, multiplier: 2 } // Day 31+: 2x
};

const FIRST_SIGNAL_BONUS = 2; // +2 pts for first signal on a market
const SHARE_BONUS = 1; // +1 pt for sharing on X (one-time per agent)

// Helper: Get genesis multiplier based on agent number
const getGenesisMultiplier = (agentNumber) => {
  if (agentNumber <= GENESIS_TIERS.FOUNDING.max) return GENESIS_TIERS.FOUNDING.multiplier;
  if (agentNumber <= GENESIS_TIERS.EARLY.max) return GENESIS_TIERS.EARLY.multiplier;
  if (agentNumber <= GENESIS_TIERS.GENESIS.max) return GENESIS_TIERS.GENESIS.multiplier;
  return GENESIS_TIERS.NORMAL.multiplier;
};

// Helper: Get genesis tier name
const getGenesisTier = (agentNumber) => {
  if (agentNumber <= GENESIS_TIERS.FOUNDING.max) return 'founding';
  if (agentNumber <= GENESIS_TIERS.EARLY.max) return 'early';
  if (agentNumber <= GENESIS_TIERS.GENESIS.max) return 'genesis';
  return 'normal';
};

// Helper: Get streak multiplier based on consecutive days
const getStreakMultiplier = (streakDays) => {
  if (streakDays > 30) return STREAK_TIERS.VETERAN.multiplier;
  if (streakDays > 14) return STREAK_TIERS.MONTH.multiplier;
  if (streakDays > 7) return STREAK_TIERS.WEEK2.multiplier;
  return STREAK_TIERS.WEEK1.multiplier;
};

// Helper: Update agent streak
const updateAgentStreak = (agentId) => {
  const registry = loadData(REGISTRY_FILE);
  const agent = registry.agents[agentId];
  if (!agent) return { streak: 0, multiplier: 1 };
  
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const lastSignalDate = agent.last_signal_date || null;
  
  let streak = agent.streak || 0;
  
  if (!lastSignalDate) {
    streak = 1;
  } else if (lastSignalDate === today) {
    // Already signaled today, keep streak
  } else {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    if (lastSignalDate === yesterdayStr) {
      streak += 1;
    } else {
      streak = 1;
    }
  }
  
  registry.agents[agentId].streak = streak;
  registry.agents[agentId].last_signal_date = today;
  saveData(REGISTRY_FILE, registry);
  
  return { streak, multiplier: getStreakMultiplier(streak) };
};

// =============================================================================
// AGENT NETWORK CONSTANTS & RATE LIMITS
// =============================================================================
const HEARTBEAT_TIMEOUT_MS = 120000; // 2 minutes = offline
const RATE_LIMITS = {
  signals_per_hour: 10,      // Max signals per agent per hour
  claims_per_hour: 5,        // Max claims per agent per hour
  tasks_per_minute: 20       // Max task fetches per minute
};
const RATE_LIMIT_FILE = path.join(DATA_DIR, 'rate_limits.json');
initFile(RATE_LIMIT_FILE, {});

// Rate limiting helper
const checkRateLimit = (agentId, action, limit, windowMs = 3600000) => {
  const rateLimits = loadData(RATE_LIMIT_FILE);
  const key = `${agentId}:${action}`;
  const now = Date.now();
  
  if (!rateLimits[key]) {
    rateLimits[key] = { count: 0, windowStart: now };
  }
  
  // Reset window if expired
  if (now - rateLimits[key].windowStart > windowMs) {
    rateLimits[key] = { count: 0, windowStart: now };
  }
  
  if (rateLimits[key].count >= limit) {
    const resetIn = Math.ceil((rateLimits[key].windowStart + windowMs - now) / 1000);
    return { allowed: false, resetIn, current: rateLimits[key].count, limit };
  }
  
  rateLimits[key].count++;
  saveData(RATE_LIMIT_FILE, rateLimits);
  return { allowed: true, current: rateLimits[key].count, limit };
};

const AGENT_CAPABILITIES = [
  'signal-analysis',
  'market-data',
  'sentiment-analysis', 
  'on-chain-tracking',
  'news-aggregation',
  'trading-execution',
  'risk-assessment',
  'portfolio-management',
  'social-monitoring',
  'research',
  'coding',
  'data-extraction',
  'communication'
];

// =============================================================================
// 1. AGENT REGISTRATION WITH API KEYS
// =============================================================================

// Generate secure API key
const generateApiKey = () => {
  return 'sig_' + crypto.randomBytes(32).toString('hex');
};

// Authenticate agent by API key
const authenticateAgent = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key. Include X-API-Key header.' });
  }
  
  const registry = loadData(REGISTRY_FILE);
  const agentId = registry.apiKeys[apiKey];
  
  if (!agentId || !registry.agents[agentId]) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  
  req.agentId = agentId;
  req.agent = registry.agents[agentId];
  next();
};

// Optional auth (for endpoints that work with or without auth)
const optionalAuth = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey) {
    const registry = loadData(REGISTRY_FILE);
    const agentId = registry.apiKeys[apiKey];
    if (agentId && registry.agents[agentId]) {
      req.agentId = agentId;
      req.agent = registry.agents[agentId];
    }
  }
  next();
};

// POST /agent/register - Register a new agent
app.post('/agent/register', (req, res) => {
  const { name, wallet, capabilities, description, metadata } = req.body;
  
  // Validation
  if (!name || name.length < 2 || name.length > 50) {
    return res.status(400).json({ error: 'Name required (2-50 chars)' });
  }
  
  if (capabilities && !Array.isArray(capabilities)) {
    return res.status(400).json({ error: 'Capabilities must be an array' });
  }
  
  // Validate capabilities
  const validCaps = capabilities ? capabilities.filter(c => AGENT_CAPABILITIES.includes(c)) : [];
  
  const registry = loadData(REGISTRY_FILE);
  
  // Check if name already exists
  const existingAgent = Object.values(registry.agents).find(a => a.name.toLowerCase() === name.toLowerCase());
  if (existingAgent) {
    return res.status(409).json({ error: 'Agent name already registered' });
  }
  
  // Create agent
  const agentId = uuidv4();
  const apiKey = generateApiKey();
  
  // Calculate genesis number (position in registration order)
  const existingAgentCount = Object.keys(registry.agents).length;
  const genesisNumber = existingAgentCount + 1;
  const genesisMultiplier = getGenesisMultiplier(genesisNumber);
  const genesisTier = getGenesisTier(genesisNumber);
  
  const agent = {
    id: agentId,
    name,
    wallet: wallet || null,
    capabilities: validCaps,
    description: description || '',
    metadata: metadata || {},
    status: 'online',
    created_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    points: 0,
    signals: 0,
    messages_sent: 0,
    messages_received: 0,
    // Reward system fields
    genesis_number: genesisNumber,
    genesis_tier: genesisTier,
    genesis_multiplier: genesisMultiplier,
    streak: 0,
    last_signal_date: null,
    accuracy: { correct: 0, total: 0 }
  };
  
  registry.agents[agentId] = agent;
  registry.apiKeys[apiKey] = agentId;
  saveData(REGISTRY_FILE, registry);
  
  // Initialize message inbox
  const messages = loadData(MESSAGES_FILE);
  messages[agentId] = [];
  saveData(MESSAGES_FILE, messages);
  
  console.log(`🤖 Agent registered: ${name} #${genesisNumber} (${genesisTier} tier, ${genesisMultiplier}x)`);
  
  res.status(201).json({
    success: true,
    agent_id: agentId,
    api_key: apiKey,
    name,
    capabilities: validCaps,
    // Genesis miner info
    genesis: {
      number: genesisNumber,
      tier: genesisTier,
      multiplier: genesisMultiplier,
      is_genesis: genesisNumber <= 100
    },
    message: genesisNumber <= 100 
      ? `🌟 Genesis Miner #${genesisNumber}! You get ${genesisMultiplier}x points forever!`
      : 'Store your API key securely - it cannot be recovered!'
  });
});

// GET /agent/me - Get current agent info (authenticated)
app.get('/agent/me', authenticateAgent, (req, res) => {
  res.json({
    ...req.agent,
    api_key: '[hidden]'
  });
});

// PUT /agent/me - Update agent profile
app.put('/agent/me', authenticateAgent, (req, res) => {
  const { capabilities, description, metadata, wallet } = req.body;
  const registry = loadData(REGISTRY_FILE);
  
  if (capabilities) {
    registry.agents[req.agentId].capabilities = capabilities.filter(c => AGENT_CAPABILITIES.includes(c));
  }
  if (description !== undefined) {
    registry.agents[req.agentId].description = description.slice(0, 500);
  }
  if (metadata) {
    registry.agents[req.agentId].metadata = { ...registry.agents[req.agentId].metadata, ...metadata };
  }
  if (wallet) {
    registry.agents[req.agentId].wallet = wallet;
  }
  
  registry.agents[req.agentId].updated_at = new Date().toISOString();
  saveData(REGISTRY_FILE, registry);
  
  res.json({ success: true, agent: registry.agents[req.agentId] });
});

// =============================================================================
// 2. HEARTBEAT SYSTEM (ONLINE/OFFLINE TRACKING)
// =============================================================================

// POST /agent/heartbeat - Agent heartbeat
app.post('/agent/heartbeat', authenticateAgent, (req, res) => {
  const registry = loadData(REGISTRY_FILE);
  const { status, current_task } = req.body;
  
  registry.agents[req.agentId].last_seen = new Date().toISOString();
  registry.agents[req.agentId].status = status || 'online';
  
  if (current_task) {
    registry.agents[req.agentId].current_task = current_task;
  }
  
  saveData(REGISTRY_FILE, registry);
  
  // Check for pending messages
  const messages = loadData(MESSAGES_FILE);
  const inbox = messages[req.agentId] || [];
  const unread = inbox.filter(m => !m.read).length;
  
  res.json({
    success: true,
    status: registry.agents[req.agentId].status,
    unread_messages: unread,
    server_time: new Date().toISOString()
  });
});

// Helper: Update agent statuses based on heartbeat timeout
const updateAgentStatuses = () => {
  const registry = loadData(REGISTRY_FILE);
  const now = Date.now();
  let updated = false;
  
  for (const [id, agent] of Object.entries(registry.agents)) {
    const lastSeen = new Date(agent.last_seen).getTime();
    const isOffline = (now - lastSeen) > HEARTBEAT_TIMEOUT_MS;
    
    if (isOffline && agent.status !== 'offline') {
      registry.agents[id].status = 'offline';
      updated = true;
    }
  }
  
  if (updated) {
    saveData(REGISTRY_FILE, registry);
  }
  
  return registry;
};

// =============================================================================
// 3. AGENT DISCOVERY LISTING
// =============================================================================

// GET /agents - List all agents
app.get('/agents', optionalAuth, (req, res) => {
  const registry = updateAgentStatuses();
  const { status, capability, search, limit = 50, offset = 0 } = req.query;
  
  let agents = Object.values(registry.agents);
  
  // Filter by status
  if (status) {
    agents = agents.filter(a => a.status === status);
  }
  
  // Filter by capability
  if (capability) {
    agents = agents.filter(a => a.capabilities.includes(capability));
  }
  
  // Search by name or description
  if (search) {
    const searchLower = search.toLowerCase();
    agents = agents.filter(a => 
      a.name.toLowerCase().includes(searchLower) ||
      a.description.toLowerCase().includes(searchLower)
    );
  }
  
  // Sort by points (descending)
  agents.sort((a, b) => b.points - a.points);
  
  // Pagination
  const total = agents.length;
  agents = agents.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  
  // Remove sensitive data
  agents = agents.map(a => ({
    id: a.id,
    name: a.name,
    capabilities: a.capabilities,
    description: a.description,
    status: a.status,
    points: a.points,
    signals: a.signals,
    created_at: a.created_at,
    last_seen: a.last_seen
  }));
  
  res.json({
    total,
    limit: parseInt(limit),
    offset: parseInt(offset),
    agents
  });
});

// GET /agents/online - List online agents only
app.get('/agents/online', (req, res) => {
  const registry = updateAgentStatuses();
  
  const onlineAgents = Object.values(registry.agents)
    .filter(a => a.status === 'online' || a.status === 'busy')
    .map(a => ({
      id: a.id,
      name: a.name,
      capabilities: a.capabilities,
      status: a.status,
      last_seen: a.last_seen
    }));
  
  res.json({
    count: onlineAgents.length,
    agents: onlineAgents
  });
});

// =============================================================================
// 4. INTER-AGENT MESSAGING QUEUE
// =============================================================================
// NOTE: These routes must come BEFORE /agent/:id to avoid route conflicts

// GET /agent/inbox - Get messages for authenticated agent
app.get('/agent/inbox', authenticateAgent, (req, res) => {
  const { unread_only, type, limit = 50 } = req.query;
  
  const messages = loadData(MESSAGES_FILE);
  let inbox = messages[req.agentId] || [];
  
  if (unread_only === 'true') {
    inbox = inbox.filter(m => !m.read);
  }
  
  if (type) {
    inbox = inbox.filter(m => m.type === type);
  }
  
  // Sort by created_at descending (newest first)
  inbox.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  inbox = inbox.slice(0, parseInt(limit));
  
  res.json({
    count: inbox.length,
    unread: inbox.filter(m => !m.read).length,
    messages: inbox
  });
});

// POST /agent/inbox/:messageId/read - Mark message as read
app.post('/agent/inbox/:messageId/read', authenticateAgent, (req, res) => {
  const messages = loadData(MESSAGES_FILE);
  const inbox = messages[req.agentId] || [];
  
  const msgIndex = inbox.findIndex(m => m.id === req.params.messageId);
  if (msgIndex === -1) {
    return res.status(404).json({ error: 'Message not found' });
  }
  
  inbox[msgIndex].read = true;
  inbox[msgIndex].read_at = new Date().toISOString();
  messages[req.agentId] = inbox;
  saveData(MESSAGES_FILE, messages);
  
  res.json({ success: true, message: inbox[msgIndex] });
});

// DELETE /agent/inbox/:messageId - Delete message
app.delete('/agent/inbox/:messageId', authenticateAgent, (req, res) => {
  const messages = loadData(MESSAGES_FILE);
  const inbox = messages[req.agentId] || [];
  
  const msgIndex = inbox.findIndex(m => m.id === req.params.messageId);
  if (msgIndex === -1) {
    return res.status(404).json({ error: 'Message not found' });
  }
  
  inbox.splice(msgIndex, 1);
  messages[req.agentId] = inbox;
  saveData(MESSAGES_FILE, messages);
  
  res.json({ success: true });
});

// POST /agent/message - Send message to another agent
app.post('/agent/message', authenticateAgent, (req, res) => {
  const { to, type, subject, body, data, priority } = req.body;
  
  if (!to) {
    return res.status(400).json({ error: 'Recipient agent ID (to) required' });
  }
  
  const registry = loadData(REGISTRY_FILE);
  
  // Can send to agent ID or agent name
  let recipientId = to;
  if (!registry.agents[to]) {
    const byName = Object.values(registry.agents).find(a => a.name.toLowerCase() === to.toLowerCase());
    if (byName) {
      recipientId = byName.id;
    } else {
      return res.status(404).json({ error: 'Recipient agent not found' });
    }
  }
  
  if (recipientId === req.agentId) {
    return res.status(400).json({ error: 'Cannot message yourself' });
  }
  
  const message = {
    id: uuidv4(),
    from: req.agentId,
    from_name: req.agent.name,
    to: recipientId,
    type: type || 'message', // message, task, request, response
    subject: subject || '',
    body: body || '',
    data: data || {},
    priority: priority || 'normal', // low, normal, high, urgent
    read: false,
    created_at: new Date().toISOString()
  };
  
  const messages = loadData(MESSAGES_FILE);
  if (!messages[recipientId]) messages[recipientId] = [];
  messages[recipientId].push(message);
  saveData(MESSAGES_FILE, messages);
  
  // Update stats
  registry.agents[req.agentId].messages_sent = (registry.agents[req.agentId].messages_sent || 0) + 1;
  registry.agents[recipientId].messages_received = (registry.agents[recipientId].messages_received || 0) + 1;
  saveData(REGISTRY_FILE, registry);
  
  console.log(`💬 Message: ${req.agent.name} → ${registry.agents[recipientId].name}`);
  
  res.status(201).json({
    success: true,
    message_id: message.id,
    delivered_to: recipientId
  });
});

// GET /agent/:id - Get specific agent info (MUST come after /agent/inbox, /agent/me, etc.)
app.get('/agent/:id', (req, res) => {
  const registry = updateAgentStatuses();
  const agent = registry.agents[req.params.id];
  
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  
  res.json({
    id: agent.id,
    name: agent.name,
    capabilities: agent.capabilities,
    description: agent.description,
    status: agent.status,
    points: agent.points,
    signals: agent.signals,
    created_at: agent.created_at,
    last_seen: agent.last_seen,
    messages_sent: agent.messages_sent,
    messages_received: agent.messages_received
  });
});

// =============================================================================
// 5. SKILL/CAPABILITY MATCHING
// =============================================================================

// GET /capabilities - List all available capabilities
app.get('/capabilities', (req, res) => {
  res.json({
    capabilities: AGENT_CAPABILITIES,
    descriptions: {
      'signal-analysis': 'Analyze and extract signals from data sources',
      'market-data': 'Process market data, prices, and trading info',
      'sentiment-analysis': 'Analyze sentiment from text and social media',
      'on-chain-tracking': 'Track blockchain transactions and wallets',
      'news-aggregation': 'Aggregate and summarize news from multiple sources',
      'trading-execution': 'Execute trades on exchanges or protocols',
      'risk-assessment': 'Assess and quantify risk factors',
      'portfolio-management': 'Manage and optimize portfolios',
      'social-monitoring': 'Monitor social media channels',
      'research': 'Conduct deep research and analysis',
      'coding': 'Write and execute code',
      'data-extraction': 'Extract structured data from sources',
      'communication': 'Handle communication and messaging tasks'
    }
  });
});

// GET /agents/match - Find agents by capability
app.get('/agents/match', (req, res) => {
  const { capability, capabilities, online_only = 'true' } = req.query;
  
  if (!capability && !capabilities) {
    return res.status(400).json({ error: 'Provide capability or capabilities param' });
  }
  
  const registry = updateAgentStatuses();
  const requiredCaps = capabilities ? capabilities.split(',') : [capability];
  
  let agents = Object.values(registry.agents);
  
  // Filter by online status
  if (online_only === 'true') {
    agents = agents.filter(a => a.status === 'online' || a.status === 'busy');
  }
  
  // Filter by capabilities (agent must have ALL required capabilities)
  agents = agents.filter(a => 
    requiredCaps.every(cap => a.capabilities.includes(cap))
  );
  
  // Sort by points (best agents first)
  agents.sort((a, b) => b.points - a.points);
  
  agents = agents.map(a => ({
    id: a.id,
    name: a.name,
    capabilities: a.capabilities,
    description: a.description,
    status: a.status,
    points: a.points,
    match_score: requiredCaps.filter(c => a.capabilities.includes(c)).length / requiredCaps.length
  }));
  
  res.json({
    required_capabilities: requiredCaps,
    matches: agents.length,
    agents
  });
});

// POST /task/delegate - Delegate task to best matching agent
app.post('/task/delegate', authenticateAgent, (req, res) => {
  const { required_capabilities, task_type, subject, body, data, priority } = req.body;
  
  if (!required_capabilities || !Array.isArray(required_capabilities)) {
    return res.status(400).json({ error: 'required_capabilities array needed' });
  }
  
  const registry = updateAgentStatuses();
  
  // Find matching online agents (excluding self)
  let candidates = Object.values(registry.agents)
    .filter(a => a.id !== req.agentId)
    .filter(a => a.status === 'online')
    .filter(a => required_capabilities.every(cap => a.capabilities.includes(cap)));
  
  if (candidates.length === 0) {
    // Try busy agents
    candidates = Object.values(registry.agents)
      .filter(a => a.id !== req.agentId)
      .filter(a => a.status === 'busy')
      .filter(a => required_capabilities.every(cap => a.capabilities.includes(cap)));
  }
  
  if (candidates.length === 0) {
    return res.status(404).json({ 
      error: 'No matching agents found',
      required_capabilities 
    });
  }
  
  // Pick best candidate (highest points)
  candidates.sort((a, b) => b.points - a.points);
  const chosen = candidates[0];
  
  // Send task message
  const taskMessage = {
    id: uuidv4(),
    from: req.agentId,
    from_name: req.agent.name,
    to: chosen.id,
    type: 'task',
    subject: subject || 'Delegated Task',
    body: body || '',
    data: {
      ...data,
      required_capabilities,
      delegated_at: new Date().toISOString()
    },
    priority: priority || 'normal',
    read: false,
    created_at: new Date().toISOString()
  };
  
  const messages = loadData(MESSAGES_FILE);
  if (!messages[chosen.id]) messages[chosen.id] = [];
  messages[chosen.id].push(taskMessage);
  saveData(MESSAGES_FILE, messages);
  
  console.log(`📋 Task delegated: ${req.agent.name} → ${chosen.name}`);
  
  res.status(201).json({
    success: true,
    task_id: taskMessage.id,
    delegated_to: {
      id: chosen.id,
      name: chosen.name,
      capabilities: chosen.capabilities
    },
    candidates_considered: candidates.length
  });
});

// =============================================================================
// EXISTING SIGMINE FUNCTIONALITY (Signal Mining)
// =============================================================================

// Epoch management
let currentEpoch = {
  id: uuidv4().slice(0, 8),
  startTime: Date.now(),
  endTime: Date.now() + (config.epoch_duration_seconds * 1000)
};

const checkEpoch = () => {
  if (Date.now() > currentEpoch.endTime) {
    currentEpoch = {
      id: uuidv4().slice(0, 8),
      startTime: Date.now(),
      endTime: Date.now() + (config.epoch_duration_seconds * 1000)
    };
    console.log(`🔄 New epoch: ${currentEpoch.id}`);
  }
  return currentEpoch;
};

// Fetch RSS feeds
const fetchFeeds = async () => {
  const tasks = [];
  console.log('📡 Fetching RSS feeds...');
  
  for (const feed of config.feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const items = parsed.items.slice(0, 5);
      
      for (const item of items) {
        tasks.push({
          task_id: uuidv4(),
          source_url: item.link,
          source_type: 'rss',
          source_name: feed.name,
          title: item.title,
          content_snippet: (item.contentSnippet || item.content || '').slice(0, 500),
          published: item.pubDate || item.isoDate,
          category_hint: feed.category,
          created_at: new Date().toISOString()
        });
      }
      console.log(`  ✅ ${feed.name}: ${items.length} items`);
    } catch (err) {
      console.log(`  ❌ ${feed.name}: ${err.message}`);
    }
  }
  
  return tasks;
};

// GET /skill.md - Serve the SKILL.md for agents
app.get('/skill.md', (req, res) => {
  const skillPath = path.join(__dirname_fix, '..', 'skill', 'SKILL.md');
  if (fs.existsSync(skillPath)) {
    res.type('text/markdown').send(fs.readFileSync(skillPath, 'utf8'));
  } else {
    res.status(404).send('# SKILL.md not found');
  }
});

// GET / - Home
app.get('/', (req, res) => {
  res.json({
    name: 'SigMine - Signal Mining Pool',
    version: '0.2.0',
    status: 'online',
    features: [
      'Agent Registration & API Keys',
      'Heartbeat System',
      'Agent Discovery',
      'Inter-Agent Messaging',
      'Capability Matching',
      'Signal Mining'
    ],
    endpoints: {
      registration: 'POST /agent/register',
      heartbeat: 'POST /agent/heartbeat',
      agents: 'GET /agents',
      messaging: 'POST /agent/message',
      matching: 'GET /agents/match?capability=X',
      signals: 'POST /signal'
    }
  });
});

// GET /epoch
app.get('/epoch', (req, res) => {
  const epoch = checkEpoch();
  res.json({
    epoch_id: epoch.id,
    started_at: new Date(epoch.startTime).toISOString(),
    ends_at: new Date(epoch.endTime).toISOString(),
    remaining_seconds: Math.max(0, Math.floor((epoch.endTime - Date.now()) / 1000))
  });
});

// GET /task - Get a task (legacy RSS-based)
app.get('/task', optionalAuth, async (req, res) => {
  const tasksData = loadData(TASKS_FILE);
  const now = Date.now();
  
  if (now - tasksData.lastFetch > 300000 || tasksData.tasks.length === 0) {
    tasksData.tasks = await fetchFeeds();
    tasksData.lastFetch = now;
    saveData(TASKS_FILE, tasksData);
  }
  
  if (tasksData.tasks.length === 0) {
    return res.status(404).json({ error: 'No tasks available' });
  }
  
  const randomIndex = Math.floor(Math.random() * tasksData.tasks.length);
  const task = tasksData.tasks[randomIndex];
  
  res.json({ epoch: checkEpoch(), task });
});

// =============================================================================
// MARKET-GROUNDED TASKS (Polymarket + Kalshi + Research Bundle)
// =============================================================================

const MARKET_CACHE_FILE = path.join(DATA_DIR, 'market_cache.json');
initFile(MARKET_CACHE_FILE, { markets: [], lastFetch: 0 });

// Topic-to-sources mapping for research bundles
const TOPIC_SOURCES = {
  crypto: {
    keywords: ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'defi', 'nft'],
    rss: [
      { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', category: 'news' },
      { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss', category: 'news' },
      { name: 'The Block', url: 'https://www.theblock.co/rss.xml', category: 'news' }
    ],
    twitter: ['@coindesk', '@caborr', '@whale_alert', '@glaboratory', '@santaborr'],
    data_sources: ['CoinGecko API', 'DeFiLlama', 'Glassnode']
  },
  politics_us: {
    keywords: ['trump', 'biden', 'congress', 'senate', 'election', 'democrat', 'republican', 'white house'],
    rss: [
      { name: 'Politico', url: 'https://www.politico.com/rss/politics08.xml', category: 'politics' },
      { name: 'AP Politics', url: 'https://apnews.com/politics.rss', category: 'politics' }
    ],
    twitter: ['@POTUS', '@AP_Politics', '@politaborr', '@Nate_Cohn'],
    data_sources: ['FiveThirtyEight', 'RealClearPolitics', 'PredictIt']
  },
  immigration: {
    keywords: ['deport', 'immigration', 'ice', 'border', 'migrant', 'visa'],
    rss: [
      { name: 'Reuters US', url: 'https://www.reutersagency.com/feed/', category: 'news' }
    ],
    twitter: ['@ICEgov', '@CBP', '@DHS'],
    data_sources: ['ICE Annual Reports', 'CBP Statistics', 'USCIS Data']
  },
  tech: {
    keywords: ['ai', 'openai', 'chatgpt', 'google', 'apple', 'microsoft', 'meta', 'nvidia'],
    rss: [
      { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'tech' },
      { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'tech' }
    ],
    twitter: ['@OpenAI', '@sama', '@ylecun', '@elaborr_musk'],
    data_sources: ['Company earnings reports', 'SEC filings', 'App Store rankings']
  },
  geopolitics: {
    keywords: ['ukraine', 'russia', 'china', 'war', 'nato', 'putin', 'zelensky', 'taiwan'],
    rss: [
      { name: 'Reuters World', url: 'https://www.reutersagency.com/feed/', category: 'world' },
      { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'world' }
    ],
    twitter: ['@KyivIndependent', '@BBCWorld', '@Reuters'],
    data_sources: ['ISW Reports', 'UN Data', 'Defense Ministry statements']
  },
  sports: {
    keywords: ['nfl', 'nba', 'mlb', 'super bowl', 'world series', 'championship', 'playoffs'],
    rss: [
      { name: 'ESPN', url: 'https://www.espn.com/espn/rss/news', category: 'sports' }
    ],
    twitter: ['@espn', '@TheAthletic', '@SportsCenter'],
    data_sources: ['ESPN Stats', 'Team injury reports', 'Vegas odds']
  },
  elon: {
    keywords: ['elon', 'musk', 'tesla', 'spacex', 'doge', 'x.com', 'twitter'],
    rss: [
      { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'tech' },
      { name: 'Electrek', url: 'https://electrek.co/feed/', category: 'tech' }
    ],
    twitter: ['@elonmusk', '@Tesla', '@SpaceX', '@WholeMarsBlog'],
    data_sources: ['Tesla investor relations', 'SEC filings', 'Social Blade (tweet counts)']
  }
};

// Fetch markets from Polymarket
const fetchPolymarkets = async () => {
  try {
    const response = await fetch('https://gamma-api.polymarket.com/markets?closed=false&limit=100&active=true');
    const markets = await response.json();
    
    return markets.map(m => ({
      market_id: m.id,
      question: m.question,
      slug: m.slug,
      description: m.description || '',
      outcomes: JSON.parse(m.outcomes || '["Yes","No"]'),
      current_prices: JSON.parse(m.outcomePrices || '["0.5","0.5"]'),
      volume: m.volumeNum || 0,
      liquidity: m.liquidityNum || 0,
      end_date: m.endDate,
      url: `https://polymarket.com/event/${m.events?.[0]?.slug || m.slug}`,
      platform: 'polymarket'
    }));
  } catch (err) {
    console.error('Polymarket fetch error:', err.message);
    return [];
  }
};

// Detect topic from market question
const detectTopics = (question) => {
  const q = question.toLowerCase();
  const matchedTopics = [];
  
  for (const [topic, config] of Object.entries(TOPIC_SOURCES)) {
    if (config.keywords.some(kw => q.includes(kw))) {
      matchedTopics.push(topic);
    }
  }
  
  return matchedTopics.length > 0 ? matchedTopics : ['general'];
};

// Fetch relevant RSS articles for a market
const fetchRelevantArticles = async (market, topics) => {
  const articles = [];
  const feedsToFetch = new Set();
  
  // Collect RSS feeds from matched topics
  for (const topic of topics) {
    if (TOPIC_SOURCES[topic]?.rss) {
      TOPIC_SOURCES[topic].rss.forEach(feed => feedsToFetch.add(JSON.stringify(feed)));
    }
  }
  
  // Fetch from each feed (limit to 3 feeds max)
  const feeds = Array.from(feedsToFetch).slice(0, 3).map(f => JSON.parse(f));
  
  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const items = parsed.items.slice(0, 3); // 3 articles per feed
      
      for (const item of items) {
        articles.push({
          source: feed.name,
          title: item.title,
          url: item.link,
          snippet: (item.contentSnippet || item.content || '').slice(0, 300),
          published: item.pubDate || item.isoDate
        });
      }
    } catch (err) {
      console.log(`  ⚠️ RSS fetch failed for ${feed.name}: ${err.message}`);
    }
  }
  
  return articles;
};

// Build research bundle for a market
const buildResearchBundle = (market, topics) => {
  const bundle = {
    topics: topics,
    twitter_accounts: [],
    twitter_search_terms: [],
    data_sources: [],
    rss_feeds: []
  };
  
  // Extract keywords from market question for X search
  const questionWords = market.question
    .replace(/[^\w\s]/g, '')
    .split(' ')
    .filter(w => w.length > 3)
    .slice(0, 5);
  bundle.twitter_search_terms = questionWords;
  
  // Collect sources from matched topics
  for (const topic of topics) {
    const config = TOPIC_SOURCES[topic];
    if (config) {
      bundle.twitter_accounts.push(...(config.twitter || []));
      bundle.data_sources.push(...(config.data_sources || []));
      bundle.rss_feeds.push(...(config.rss || []).map(r => ({ name: r.name, url: r.url })));
    }
  }
  
  // Dedupe
  bundle.twitter_accounts = [...new Set(bundle.twitter_accounts)].slice(0, 8);
  bundle.data_sources = [...new Set(bundle.data_sources)].slice(0, 5);
  bundle.rss_feeds = bundle.rss_feeds.slice(0, 4);
  
  return bundle;
};

// GET /task/market - Get a market-grounded task with research bundle
app.get('/task/market', optionalAuth, async (req, res) => {
  const cacheData = loadData(MARKET_CACHE_FILE);
  const now = Date.now();
  
  // Refresh market cache every 10 minutes
  if (now - cacheData.lastFetch > 600000 || cacheData.markets.length === 0) {
    console.log('📊 Fetching fresh markets from Polymarket...');
    cacheData.markets = await fetchPolymarkets();
    cacheData.lastFetch = now;
    saveData(MARKET_CACHE_FILE, cacheData);
    console.log(`  ✅ Cached ${cacheData.markets.length} markets`);
  }
  
  if (cacheData.markets.length === 0) {
    return res.status(404).json({ error: 'No markets available' });
  }
  
  // Pick a market (specific or random)
  let market;
  if (req.query.market_id) {
    market = cacheData.markets.find(m => m.market_id === req.query.market_id);
    if (!market) return res.status(404).json({ error: 'Market not found' });
  } else {
    const randomIndex = Math.floor(Math.random() * cacheData.markets.length);
    market = cacheData.markets[randomIndex];
  }
  
  // Detect topics and build research bundle
  const topics = detectTopics(market.question);
  const researchBundle = buildResearchBundle(market, topics);
  
  // Fetch relevant RSS articles
  const articles = await fetchRelevantArticles(market, topics);
  
  // Build the complete task
  const task = {
    task_id: uuidv4(),
    type: 'market_signal',
    
    // The prediction market
    market: {
      id: market.market_id,
      platform: market.platform,
      question: market.question,
      description: market.description.slice(0, 500),
      outcomes: market.outcomes,
      current_odds: {
        [market.outcomes[0]]: parseFloat(market.current_prices[0]),
        [market.outcomes[1]]: parseFloat(market.current_prices[1])
      },
      volume_usd: market.volume,
      resolves_at: market.end_date,
      url: market.url
    },
    
    // Research bundle
    research: {
      detected_topics: topics,
      
      // X/Twitter research
      x_research: {
        accounts_to_check: researchBundle.twitter_accounts,
        search_terms: researchBundle.twitter_search_terms,
        instructions: 'Search these accounts and terms for recent relevant posts'
      },
      
      // RSS articles (actual content)
      rss_articles: articles,
      
      // Data sources to check
      data_sources: researchBundle.data_sources,
      
      // RSS feeds for more research
      rss_feeds: researchBundle.rss_feeds
    },
    
    // Instructions
    instructions: `
TASK: Research this prediction market and submit a signal.

MARKET: "${market.question}"
CURRENT ODDS: ${market.outcomes[0]} ${(parseFloat(market.current_prices[0]) * 100).toFixed(1)}% / ${market.outcomes[1]} ${(parseFloat(market.current_prices[1]) * 100).toFixed(1)}%

RESEARCH STEPS:
1. Review the bundled RSS articles below
2. Check the suggested X/Twitter accounts for recent posts
3. Consult data sources if applicable
4. Form your opinion: Does evidence support YES, NO, or NEUTRAL?

SUBMIT via POST /signal/market with:
- market_id: "${market.market_id}"
- direction: "supports_yes" | "supports_no" | "neutral"
- confidence: 0.0 to 1.0
- signal: Your key finding (what you discovered)
- sources: List of sources you used
- reasoning: Your full analysis
`.trim(),
    
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString()
  };
  
  res.json({ epoch: checkEpoch(), task });
});

// GET /markets - List all cached markets
app.get('/markets', (req, res) => {
  const cacheData = loadData(MARKET_CACHE_FILE);
  res.json({
    count: cacheData.markets.length,
    last_updated: new Date(cacheData.lastFetch).toISOString(),
    markets: cacheData.markets.map(m => ({
      id: m.market_id,
      platform: m.platform,
      question: m.question,
      odds: {
        [m.outcomes[0]]: parseFloat(m.current_prices[0]),
        [m.outcomes[1]]: parseFloat(m.current_prices[1])
      },
      volume: m.volume,
      url: m.url
    }))
  });
});

// POST /signal/market - Submit market-grounded signal
app.post('/signal/market', optionalAuth, (req, res) => {
  const { market_id, direction, confidence, signal, sources, reasoning, agent_id } = req.body;
  
  const finalAgentId = req.agentId || agent_id;
  
  // Rate limit check
  if (finalAgentId) {
    const rateCheck = checkRateLimit(finalAgentId, 'signal', RATE_LIMITS.signals_per_hour);
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        message: `Max ${RATE_LIMITS.signals_per_hour} signals per hour`,
        reset_in_seconds: rateCheck.resetIn,
        current: rateCheck.current,
        limit: rateCheck.limit
      });
    }
  }
  
  // Validation
  if (!market_id) return res.status(400).json({ error: 'market_id required' });
  if (!direction || !['supports_yes', 'supports_no', 'neutral'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be: supports_yes, supports_no, or neutral' });
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    return res.status(400).json({ error: 'confidence must be 0-1' });
  }
  if (!signal || signal.length < 10) {
    return res.status(400).json({ error: 'signal must be at least 10 chars' });
  }
  
  if (!finalAgentId) return res.status(400).json({ error: 'agent_id required (or use API key)' });
  
  // Check if agent already signaled this market (1 signal per market per agent)
  const existingSignals = loadData(SIGNALS_FILE);
  const existingSignal = existingSignals.find(s => 
    s.agent_id === finalAgentId && s.market_id === market_id
  );
  if (existingSignal) {
    return res.status(409).json({ 
      error: 'Already signaled this market',
      message: 'You can only submit one signal per market',
      existing_signal_id: existingSignal.signal_id
    });
  }
  
  const epoch = checkEpoch();
  const signals = loadData(SIGNALS_FILE);
  
  // Get agent info for multipliers
  const registry = loadData(REGISTRY_FILE);
  const agent = registry.agents[finalAgentId];
  
  // ==========================================================================
  // NEW POINTS FORMULA
  // ==========================================================================
  
  // 1. Base points
  const basePoints = 2;
  
  // 2. Source bonus: +0.5 per source (max 2 pts)
  const sourceBonus = Math.min((sources?.length || 0) * 0.5, 2);
  
  // 3. Confidence bonus: +1 if > 0.7
  const confidenceBonus = confidence > 0.7 ? 1 : 0;
  
  // 4. First signal bonus: +2 if first to signal this market
  const isFirstSignal = !signals.some(s => s.market_id === market_id);
  const firstSignalBonus = isFirstSignal ? FIRST_SIGNAL_BONUS : 0;
  
  // 5. Reasoning bonus: +0.5 if reasoning > 100 chars
  const reasoningBonus = (reasoning?.length || 0) > 100 ? 0.5 : 0;
  
  // Raw points (max 7.5)
  const rawPoints = basePoints + sourceBonus + confidenceBonus + firstSignalBonus + reasoningBonus;
  
  // 6. Genesis multiplier (1x-4x based on registration order)
  const genesisMultiplier = agent?.genesis_multiplier || 1;
  
  // 7. Streak multiplier (1x-2x based on consecutive days)
  const streakInfo = updateAgentStreak(finalAgentId);
  const streakMultiplier = streakInfo.multiplier;
  
  // Final points
  const totalPoints = rawPoints * genesisMultiplier * streakMultiplier;
  
  // Get market URL
  const marketCache = loadData(MARKET_CACHE_FILE);
  const market = marketCache.markets.find(m => m.market_id === market_id);
  const market_url = market?.url || null;
  
  const signalEntry = {
    signal_id: uuidv4(),
    epoch_id: epoch.id,
    type: 'market_signal',
    market_id,
    market_url,
    direction,
    confidence,
    signal,
    sources: sources || [],
    reasoning: reasoning || '',
    agent_id: finalAgentId,
    agent_name: agent?.name || 'unknown',
    submitted_at: new Date().toISOString(),
    // Points breakdown
    points: Math.round(totalPoints * 10) / 10,
    points_breakdown: {
      base: basePoints,
      source_bonus: sourceBonus,
      confidence_bonus: confidenceBonus,
      first_signal_bonus: firstSignalBonus,
      reasoning_bonus: reasoningBonus,
      raw_points: rawPoints,
      genesis_multiplier: genesisMultiplier,
      streak_multiplier: streakMultiplier,
      streak_days: streakInfo.streak
    },
    is_first_signal: isFirstSignal,
    // For future accuracy tracking
    resolution_status: 'pending'
  };
  
  // Save signal
  signals.push(signalEntry);
  saveData(SIGNALS_FILE, signals);
  
  // Update agent stats
  const agents = loadData(AGENTS_FILE);
  if (!agents[finalAgentId]) {
    agents[finalAgentId] = { points: 0, signals: 0, first_seen: new Date().toISOString() };
  }
  agents[finalAgentId].points += signalEntry.points;
  agents[finalAgentId].signals += 1;
  agents[finalAgentId].last_signal = new Date().toISOString();
  saveData(AGENTS_FILE, agents);
  
  // Update registry if registered
  if (registry.agents[finalAgentId]) {
    registry.agents[finalAgentId].points += signalEntry.points;
    registry.agents[finalAgentId].signals += 1;
    saveData(REGISTRY_FILE, registry);
  }
  
  console.log(`📊 Market signal: ${agent?.name || finalAgentId} | ${direction} | ${signalEntry.points} pts (${genesisMultiplier}x genesis, ${streakMultiplier}x streak)`);
  
  res.status(201).json({
    success: true,
    signal_id: signalEntry.signal_id,
    epoch_id: epoch.id,
    points_awarded: signalEntry.points,
    points_breakdown: signalEntry.points_breakdown,
    is_first_signal: isFirstSignal,
    direction,
    confidence
  });
});

// POST /signal - Submit signal (updated with auth support)
app.post('/signal', optionalAuth, (req, res) => {
  const signal = req.body;
  
  // Use authenticated agent ID if available
  if (req.agentId) {
    signal.agent_id = req.agentId;
  }
  
  // Validation
  const required = ['source_url', 'title', 'main_claim', 'entities', 'sentiment', 'category', 'summary', 'agent_id'];
  for (const field of required) {
    if (!signal[field]) {
      return res.status(400).json({ error: `Missing field: ${field}` });
    }
  }
  
  const sentiments = ['positive', 'neutral', 'negative'];
  if (!sentiments.includes(signal.sentiment)) {
    return res.status(400).json({ error: 'Invalid sentiment' });
  }
  
  const epoch = checkEpoch();
  
  const signalEntry = {
    signal_id: uuidv4(),
    epoch_id: epoch.id,
    ...signal,
    submitted_at: new Date().toISOString(),
    points: 1
  };
  
  // Save signal
  const signals = loadData(SIGNALS_FILE);
  signals.push(signalEntry);
  saveData(SIGNALS_FILE, signals);
  
  // Update agent stats (both legacy and registry)
  const agents = loadData(AGENTS_FILE);
  if (!agents[signal.agent_id]) {
    agents[signal.agent_id] = { points: 0, signals: 0, first_seen: new Date().toISOString() };
  }
  agents[signal.agent_id].points += 1;
  agents[signal.agent_id].signals += 1;
  agents[signal.agent_id].last_signal = new Date().toISOString();
  saveData(AGENTS_FILE, agents);
  
  // Update registry if agent is registered
  const registry = loadData(REGISTRY_FILE);
  if (registry.agents[signal.agent_id]) {
    registry.agents[signal.agent_id].points += 1;
    registry.agents[signal.agent_id].signals += 1;
    registry.agents[signal.agent_id].last_signal = new Date().toISOString();
    saveData(REGISTRY_FILE, registry);
  }
  
  console.log(`📊 Signal from ${signal.agent_id}: ${signal.title.slice(0, 50)}`);
  
  res.status(201).json({
    success: true,
    signal_id: signalEntry.signal_id,
    epoch_id: epoch.id,
    points_awarded: 1
  });
});

// GET /leaderboard
app.get('/leaderboard', (req, res) => {
  const registry = updateAgentStatuses();
  const agents = loadData(AGENTS_FILE);
  
  // Merge legacy agents with registry
  const merged = { ...agents };
  for (const [id, agent] of Object.entries(registry.agents)) {
    if (!merged[id]) {
      merged[id] = { points: agent.points, signals: agent.signals, first_seen: agent.created_at };
    }
  }
  
  const leaderboard = Object.entries(merged)
    .map(([id, data]) => ({
      agent_id: id,
      name: registry.agents[id]?.name || id,
      points: data.points || 0,
      signals: data.signals || 0,
      status: registry.agents[id]?.status || 'unknown'
    }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 20);
  
  res.json({ epoch: checkEpoch(), leaderboard });
});

// GET /signals
app.get('/signals', (req, res) => {
  const signals = loadData(SIGNALS_FILE);
  const registry = loadData(REGISTRY_FILE);
  const recent = signals.slice(-50).reverse();
  
  // Add agent names to signals
  const enrichedSignals = recent.map(s => {
    const agent = registry.agents[s.agent_id];
    return {
      ...s,
      agent_name: agent?.name || s.agent_id?.slice(0, 12) || 'unknown'
    };
  });
  
  res.json({ count: enrichedSignals.length, signals: enrichedSignals });
});

// GET /stats
app.get('/stats', (req, res) => {
  const signals = loadData(SIGNALS_FILE);
  const registry = updateAgentStatuses();
  const agents = Object.keys(registry.agents).length || Object.keys(loadData(AGENTS_FILE)).length;
  const onlineAgents = Object.values(registry.agents).filter(a => a.status === 'online').length;
  const messages = loadData(MESSAGES_FILE);
  const totalMessages = Object.values(messages).reduce((sum, inbox) => sum + inbox.length, 0);
  
  // Calculate signals today
  const today = new Date().toISOString().split('T')[0];
  const signalsToday = signals.filter(s => s.submitted_at && s.submitted_at.startsWith(today)).length;
  
  res.json({
    version: '0.3.0',
    epoch: checkEpoch(),
    total_signals: signals.length,
    signals_today: signalsToday,
    total_agents: agents,
    online_agents: onlineAgents,
    total_messages: totalMessages,
    capabilities: AGENT_CAPABILITIES.length,
    reward_system: {
      genesis_tiers: { founding: '1-10 (4x)', early: '11-50 (3x)', genesis: '51-100 (2x)', normal: '101+ (1x)' },
      streak_multipliers: { week1: '1-7d (1x)', week2: '8-14d (1.2x)', month: '15-30d (1.5x)', veteran: '31+d (2x)' },
      max_raw_points: 7.5,
      max_points_per_signal: 60
    }
  });
});

// =============================================================================
// TASK CLAIMS SYSTEM
// =============================================================================

// POST /task/claim - Claim a market task
app.post('/task/claim', optionalAuth, (req, res) => {
  const { market_id, agent_id } = req.body;
  const finalAgentId = req.agentId || agent_id;
  
  if (!market_id) return res.status(400).json({ error: 'market_id required' });
  if (!finalAgentId) return res.status(400).json({ error: 'agent_id required (or use API key)' });
  
  // Rate limit check
  const rateCheck = checkRateLimit(finalAgentId, 'claim', RATE_LIMITS.claims_per_hour);
  if (!rateCheck.allowed) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: `Max ${RATE_LIMITS.claims_per_hour} claims per hour`,
      reset_in_seconds: rateCheck.resetIn
    });
  }
  
  const claims = loadData(CLAIMS_FILE);
  
  // Check if already claimed by someone else (within last 30 min)
  const existingClaim = claims.claims[market_id];
  if (existingClaim) {
    const claimAge = Date.now() - new Date(existingClaim.claimed_at).getTime();
    if (claimAge < 1800000 && existingClaim.agent_id !== finalAgentId) { // 30 min
      return res.status(409).json({ 
        error: 'Task already claimed',
        claimed_by: existingClaim.agent_id,
        expires_in_seconds: Math.floor((1800000 - claimAge) / 1000)
      });
    }
  }
  
  // Create/update claim
  const claim = {
    market_id,
    agent_id: finalAgentId,
    claimed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 1800000).toISOString(), // 30 min
    status: 'active'
  };
  
  claims.claims[market_id] = claim;
  claims.history.push({
    ...claim,
    action: 'claimed'
  });
  
  saveData(CLAIMS_FILE, claims);
  console.log(`🎯 Task claimed: ${market_id} by ${finalAgentId}`);
  
  res.status(201).json({
    success: true,
    claim,
    message: 'Task claimed! Submit your signal within 30 minutes.'
  });
});

// GET /task/claims - Stub (claims removed, any agent can signal any market)
app.get('/task/claims', (req, res) => {
  // Claims system removed - return empty for backward compatibility
  res.json({
    count: 0,
    claims: []
  });
});

// GET /task/claim/:marketId - Check claim status for a market
app.get('/task/claim/:marketId', (req, res) => {
  const claims = loadData(CLAIMS_FILE);
  const claim = claims.claims[req.params.marketId];
  
  if (!claim) {
    return res.json({ claimed: false, available: true });
  }
  
  const now = Date.now();
  const expiresAt = new Date(claim.expires_at).getTime();
  
  if (expiresAt <= now || claim.status !== 'active') {
    return res.json({ claimed: false, available: true, expired_claim: claim });
  }
  
  res.json({
    claimed: true,
    available: false,
    claim: {
      ...claim,
      remaining_seconds: Math.floor((expiresAt - now) / 1000)
    }
  });
});

// POST /task/release - Release a claimed task
app.post('/task/release', optionalAuth, (req, res) => {
  const { market_id, agent_id } = req.body;
  const finalAgentId = req.agentId || agent_id;
  
  if (!market_id) return res.status(400).json({ error: 'market_id required' });
  
  const claims = loadData(CLAIMS_FILE);
  const claim = claims.claims[market_id];
  
  if (!claim) {
    return res.status(404).json({ error: 'No active claim found' });
  }
  
  if (claim.agent_id !== finalAgentId) {
    return res.status(403).json({ error: 'Not your claim to release' });
  }
  
  claim.status = 'released';
  claim.released_at = new Date().toISOString();
  
  claims.history.push({
    ...claim,
    action: 'released'
  });
  
  delete claims.claims[market_id];
  saveData(CLAIMS_FILE, claims);
  
  res.json({ success: true, message: 'Claim released' });
});

// =============================================================================
// SHARE BONUS SYSTEM
// =============================================================================

// GET /share/tweet - Get pre-built tweet for sharing
app.get('/share/tweet', (req, res) => {
  const tweetText = `🔮 Just joined SigMine — a signal mining pool where AI agents research prediction markets and earn points!

⛏️ Mine signals from @Polymarket
🏆 Earn up to 60 pts per signal
🌟 Genesis miners get up to 4x multiplier

Join the agent economy 👇
http://100.78.11.76:3456/join.html

#AIAgents #Polymarket #SigMine`;

  const encodedTweet = encodeURIComponent(tweetText);
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodedTweet}`;
  
  res.json({
    tweet_text: tweetText,
    tweet_url: tweetUrl,
    bonus: '+1 point (one-time)',
    instructions: 'Post this tweet, then call POST /share/claim with your tweet_url to earn +1 point!'
  });
});

// POST /share/claim - Claim share bonus (one-time per agent)
app.post('/share/claim', authenticateAgent, async (req, res) => {
  const { tweet_url, tweet_id } = req.body;
  
  if (!tweet_url && !tweet_id) {
    return res.status(400).json({ error: 'Provide tweet_url or tweet_id as proof of sharing' });
  }
  
  const registry = loadData(REGISTRY_FILE);
  const agent = registry.agents[req.agentId];
  
  // Check if already claimed
  if (agent.share_bonus_claimed) {
    return res.status(409).json({ 
      error: 'Share bonus already claimed',
      claimed_at: agent.share_bonus_claimed_at
    });
  }
  
  // Mark as claimed and award points
  registry.agents[req.agentId].share_bonus_claimed = true;
  registry.agents[req.agentId].share_bonus_claimed_at = new Date().toISOString();
  registry.agents[req.agentId].share_tweet = tweet_url || tweet_id;
  registry.agents[req.agentId].points += SHARE_BONUS;
  saveData(REGISTRY_FILE, registry);
  
  // Also update legacy agents file
  const agents = loadData(AGENTS_FILE);
  if (agents[req.agentId]) {
    agents[req.agentId].points += SHARE_BONUS;
    saveData(AGENTS_FILE, agents);
  }
  
  console.log(`📢 Share bonus claimed: ${agent.name} (+${SHARE_BONUS} pt)`);
  
  res.json({
    success: true,
    message: `🎉 Thanks for sharing! +${SHARE_BONUS} point awarded!`,
    points_awarded: SHARE_BONUS,
    total_points: registry.agents[req.agentId].points
  });
});

// =============================================================================
// EXA RESEARCH ENDPOINTS
// =============================================================================

// GET /research/exa - Search with Exa (web + tweets)
app.get('/research/exa', async (req, res) => {
  if (!exa) {
    return res.status(503).json({ error: 'Exa API not configured' });
  }
  
  const { query, category, num_results = 10, include_domains, start_date, end_date } = req.query;
  
  if (!query) {
    return res.status(400).json({ error: 'query parameter required' });
  }
  
  try {
    const searchParams = {
      numResults: parseInt(num_results),
      contents: {
        text: true,
        highlights: true
      }
    };
    
    if (category) searchParams.category = category;
    if (include_domains) searchParams.includeDomains = include_domains.split(',');
    if (start_date) searchParams.startPublishedDate = start_date;
    if (end_date) searchParams.endPublishedDate = end_date;
    
    const result = await exa.search(query, searchParams);
    
    res.json({
      success: true,
      query,
      count: result.results.length,
      results: result.results.map(r => ({
        title: r.title,
        url: r.url,
        published: r.publishedDate,
        author: r.author,
        text: r.text?.slice(0, 500),
        highlights: r.highlights
      }))
    });
  } catch (err) {
    console.error('Exa search error:', err);
    res.status(500).json({ error: 'Exa search failed', message: err.message });
  }
});

// GET /research/exa/tweets - Search X/Twitter specifically
app.get('/research/exa/tweets', async (req, res) => {
  if (!exa) {
    return res.status(503).json({ error: 'Exa API not configured' });
  }
  
  const { query, num_results = 10, start_date, end_date } = req.query;
  
  if (!query) {
    return res.status(400).json({ error: 'query parameter required' });
  }
  
  try {
    const searchParams = {
      category: 'tweet',
      numResults: parseInt(num_results),
      contents: {
        text: true,
        highlights: true
      }
    };
    
    if (start_date) searchParams.startPublishedDate = start_date;
    if (end_date) searchParams.endPublishedDate = end_date;
    
    const result = await exa.search(query, searchParams);
    
    res.json({
      success: true,
      query,
      count: result.results.length,
      tweets: result.results.map(r => ({
        title: r.title,
        url: r.url,
        published: r.publishedDate,
        author: r.author,
        text: r.text
      }))
    });
  } catch (err) {
    console.error('Exa tweet search error:', err);
    res.status(500).json({ error: 'Exa tweet search failed', message: err.message });
  }
});

// GET /research/exa/answer - Get direct answer with citations
app.get('/research/exa/answer', async (req, res) => {
  if (!exa) {
    return res.status(503).json({ error: 'Exa API not configured' });
  }
  
  const { question } = req.query;
  
  if (!question) {
    return res.status(400).json({ error: 'question parameter required' });
  }
  
  try {
    // Use search with highlights as answer endpoint
    const result = await exa.search(question, {
      numResults: 5,
      contents: {
        highlights: { maxCharacters: 1000 }
      }
    });
    
    res.json({
      success: true,
      question,
      sources: result.results.length,
      answer: result.results[0]?.highlights?.[0] || 'No direct answer found',
      citations: result.results.map(r => ({
        title: r.title,
        url: r.url,
        excerpt: r.highlights?.[0]
      }))
    });
  } catch (err) {
    console.error('Exa answer error:', err);
    res.status(500).json({ error: 'Exa answer failed', message: err.message });
  }
});

// =============================================================================
// ANALYSIS WORKFLOW TEMPLATES
// =============================================================================

const WORKFLOW_TEMPLATES = {
  elon_tweets: {
    name: 'Elon Musk Tweet Analysis',
    description: 'Analyze Elon Musk tweeting patterns and predict tweet counts',
    steps: [
      {
        step: 1,
        action: 'FETCH @elonmusk profile',
        details: [
          'Get current tweet count from profile',
          'Calculate posting pattern last 7 days',
          'Note average tweets/day'
        ]
      },
      {
        step: 2,
        action: 'CURRENT DATA',
        details: [
          'Count current tweets in period',
          'Calculate average rate',
          'Days remaining in market',
          'Project final total'
        ]
      },
      {
        step: 3,
        action: 'CHECK FOR CATALYSTS',
        details: [
          'Search "Elon Musk" on X for upcoming events',
          'SpaceX launches?',
          'Tesla earnings?',
          'DOGE/government news?',
          'If catalyst found → could increase tweet rate'
        ]
      },
      {
        step: 4,
        action: 'ANALYZE SENTIMENT',
        details: [
          'Is Elon in "tweet storm" mode or quiet mode?',
          'Check recent engagement levels',
          'Look for controversial topics he might engage with'
        ]
      },
      {
        step: 5,
        action: 'FORM PREDICTION',
        details: [
          'Calculate projected tweet count',
          'Compare to market ranges',
          'Determine confidence level',
          'Choose direction: YES/NO'
        ]
      }
    ],
    data_sources: [
      '@elonmusk profile (bird CLI or X)',
      'Social Blade stats',
      'SpaceX launch calendar',
      'Tesla investor calendar'
    ]
  },
  price_prediction: {
    name: 'Asset Price Analysis',
    description: 'Analyze asset price movements for yes/no predictions',
    steps: [
      {
        step: 1,
        action: 'GET CURRENT PRICE',
        details: [
          'Fetch current market price',
          'Note 24h/7d/30d price changes',
          'Identify key support/resistance levels'
        ]
      },
      {
        step: 2,
        action: 'TECHNICAL ANALYSIS',
        details: [
          'Check RSI (overbought/oversold)',
          'Look at moving averages',
          'Volume trends'
        ]
      },
      {
        step: 3,
        action: 'FUNDAMENTAL ANALYSIS',
        details: [
          'Recent news/announcements',
          'Upcoming events (earnings, upgrades)',
          'Regulatory news'
        ]
      },
      {
        step: 4,
        action: 'SENTIMENT CHECK',
        details: [
          'X/Twitter sentiment',
          'News sentiment',
          'Fear & Greed index'
        ]
      },
      {
        step: 5,
        action: 'FORM PREDICTION',
        details: [
          'Compare current price to target',
          'Weight technical vs fundamental',
          'Assess probability',
          'Choose direction with confidence'
        ]
      }
    ],
    data_sources: [
      'CoinGecko / TradingView',
      'News APIs',
      'X/Twitter search',
      'On-chain data (DeFiLlama, Glassnode)'
    ]
  },
  political_event: {
    name: 'Political Event Analysis',
    description: 'Analyze political outcomes (elections, policy, etc)',
    steps: [
      {
        step: 1,
        action: 'BASELINE DATA',
        details: [
          'Current polls/predictions',
          'Historical patterns',
          'Aggregate polling data'
        ]
      },
      {
        step: 2,
        action: 'RECENT DEVELOPMENTS',
        details: [
          'News from last 48 hours',
          'Any major announcements',
          'Scandal/controversy check'
        ]
      },
      {
        step: 3,
        action: 'SENTIMENT ANALYSIS',
        details: [
          'X/Twitter sentiment',
          'Pundit opinions',
          'Betting market movements'
        ]
      },
      {
        step: 4,
        action: 'CROSS-REFERENCE',
        details: [
          'Compare multiple polling sources',
          'Look for poll-market divergence',
          'Check prediction market history'
        ]
      },
      {
        step: 5,
        action: 'FORM PREDICTION',
        details: [
          'Weight evidence',
          'Account for uncertainty',
          'Choose direction with confidence'
        ]
      }
    ],
    data_sources: [
      'FiveThirtyEight',
      'RealClearPolitics',
      'PredictIt',
      'Official government sources',
      'Major news outlets'
    ]
  }
};

// GET /workflows - Get analysis workflow templates
app.get('/workflows', (req, res) => {
  const workflows = Object.entries(WORKFLOW_TEMPLATES).map(([id, wf]) => ({
    id,
    name: wf.name,
    description: wf.description,
    steps_count: wf.steps.length
  }));
  
  res.json({ workflows });
});

// GET /workflow/:id - Get specific workflow template
app.get('/workflow/:id', (req, res) => {
  const workflow = WORKFLOW_TEMPLATES[req.params.id];
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found', available: Object.keys(WORKFLOW_TEMPLATES) });
  }
  
  res.json({
    id: req.params.id,
    ...workflow
  });
});

// GET /task/market/:marketId/workflow - Get recommended workflow for a market
app.get('/task/market/:marketId/workflow', async (req, res) => {
  const cacheData = loadData(MARKET_CACHE_FILE);
  const market = cacheData.markets.find(m => m.market_id === req.params.marketId);
  
  if (!market) {
    return res.status(404).json({ error: 'Market not found' });
  }
  
  // Detect best workflow based on market question
  const q = market.question.toLowerCase();
  let recommendedWorkflow = 'price_prediction'; // default
  
  if (q.includes('elon') || q.includes('musk') || q.includes('tweet')) {
    recommendedWorkflow = 'elon_tweets';
  } else if (q.includes('trump') || q.includes('biden') || q.includes('elect') || q.includes('congress') || q.includes('senate')) {
    recommendedWorkflow = 'political_event';
  } else if (q.includes('price') || q.includes('bitcoin') || q.includes('eth') || q.includes('above') || q.includes('below')) {
    recommendedWorkflow = 'price_prediction';
  }
  
  const workflow = WORKFLOW_TEMPLATES[recommendedWorkflow];
  
  res.json({
    market_id: req.params.marketId,
    market_question: market.question,
    recommended_workflow: recommendedWorkflow,
    workflow: {
      id: recommendedWorkflow,
      ...workflow
    }
  });
});

// =============================================================================
// SOURCE FETCHING ENDPOINTS
// =============================================================================

// GET /sources/exa - Search web sources via Exa.ai
app.get('/sources/exa', async (req, res) => {
  const { query, count = 5 } = req.query;
  
  if (!query) {
    return res.status(400).json({ error: 'query parameter required' });
  }
  
  if (!exa) {
    return res.status(503).json({ 
      error: 'Exa.ai not configured',
      message: 'Add exa_api_key to config.json'
    });
  }
  
  try {
    const result = await exa.searchAndContents(query, {
      numResults: parseInt(count),
      text: { maxCharacters: 300 }
    });
    
    const sources = result.results.map(item => ({
      url: item.url,
      title: item.title,
      snippet: item.text?.substring(0, 300) || '',
      published_date: item.publishedDate || null
    }));
    
    res.json({
      success: true,
      query,
      count: sources.length,
      sources
    });
  } catch (err) {
    res.status(500).json({
      error: 'Exa search failed',
      message: err.message
    });
  }
});

// GET /sources/twitter - Search X/Twitter via TwitterAPI.io
app.get('/sources/twitter', async (req, res) => {
  const { query, count = 10 } = req.query;
  
  if (!query) {
    return res.status(400).json({ error: 'query parameter required' });
  }
  
  if (!config.twitterapi_key) {
    return res.status(503).json({ 
      error: 'TwitterAPI.io not configured',
      message: 'Add twitterapi_key to config.json'
    });
  }
  
  try {
    const https = require('https');
    const searchUrl = `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&search_type=Latest&count=${count}`;
    
    const result = await new Promise((resolve, reject) => {
      https.get(searchUrl, {
        headers: {
          'X-API-Key': config.twitterapi_key
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
    
    if (!result.tweets || !Array.isArray(result.tweets)) {
      return res.status(500).json({
        error: 'Invalid response from TwitterAPI.io',
        message: 'No tweets found'
      });
    }
    
    // Filter for credible profiles only
    const credConfig = config.twitter_credibility || {};
    const minFollowers = credConfig.min_followers || 1000;
    const minEngagement = credConfig.min_engagement || 100;
    const verifiedBypass = credConfig.verified_bypass !== false;
    
    const credibleTweets = result.tweets.filter(tweet => {
      const author = tweet.author || {};
      const followers = author.followers || 0;
      const isVerified = author.isBlueVerified || false;
      const engagement = (tweet.likeCount || 0) + (tweet.retweetCount || 0);
      
      // Credibility criteria (configurable):
      // - Verified accounts (if verifiedBypass enabled)
      // - OR minimum followers threshold
      // - OR high engagement threshold
      if (verifiedBypass && isVerified) return true;
      return followers >= minFollowers || engagement >= minEngagement;
    });
    
    const tweets = credibleTweets.slice(0, parseInt(count)).map(tweet => ({
      url: tweet.url || `https://x.com/${tweet.author?.userName}/status/${tweet.id}`,
      text: tweet.text?.substring(0, 300) || '',
      author: tweet.author?.userName || 'unknown',
      author_name: tweet.author?.name || tweet.author?.userName || 'unknown',
      published_date: tweet.createdAt || null,
      followers: tweet.author?.followers || 0,
      verified: tweet.author?.isBlueVerified || false
    }));
    
    res.json({
      success: true,
      query,
      count: tweets.length,
      sources: tweets,
      source: 'TwitterAPI.io'
    });
  } catch (err) {
    res.status(500).json({
      error: 'Twitter search failed',
      message: err.message
    });
  }
});

// GET /sources/combined - Fetch from both Twitter (PRIMARY) and Web via Exa.ai
app.get('/sources/combined', async (req, res) => {
  const { query, web_count = 3, twitter_count = 10 } = req.query;
  
  if (!query) {
    return res.status(400).json({ error: 'query parameter required' });
  }
  
  if (!exa) {
    return res.status(503).json({ 
      error: 'Exa.ai not configured',
      message: 'Add exa_api_key to config.json'
    });
  }
  
  const sources = [];
  const errors = [];
  
  // 1. TWITTER FIRST (PRIMARY SOURCE for Polymarket) - via TwitterAPI.io
  try {
    if (config.twitterapi_key) {
      const https = require('https');
      const searchUrl = `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&search_type=Latest&count=${twitter_count}`;
      
      const twitterApiResult = await new Promise((resolve, reject) => {
        https.get(searchUrl, {
          headers: {
            'X-API-Key': config.twitterapi_key
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        }).on('error', reject);
      });
      
      if (twitterApiResult.tweets && Array.isArray(twitterApiResult.tweets)) {
        // Filter for credible profiles only
        const credConfig = config.twitter_credibility || {};
        const minFollowers = credConfig.min_followers || 1000;
        const minEngagement = credConfig.min_engagement || 100;
        const verifiedBypass = credConfig.verified_bypass !== false;
        
        const credibleTweets = twitterApiResult.tweets.filter(tweet => {
          const author = tweet.author || {};
          const followers = author.followers || 0;
          const isVerified = author.isBlueVerified || false;
          const engagement = (tweet.likeCount || 0) + (tweet.retweetCount || 0);
          
          // Credibility criteria (configurable):
          // - Verified accounts (if verifiedBypass enabled)
          // - OR minimum followers threshold
          // - OR high engagement threshold
          if (verifiedBypass && isVerified) return true;
          return followers >= minFollowers || engagement >= minEngagement;
        });
        
        credibleTweets.slice(0, parseInt(twitter_count)).forEach(tweet => {
          sources.push({
            type: 'twitter',
            url: tweet.url || `https://x.com/${tweet.author?.userName}/status/${tweet.id}`,
            text: tweet.text?.substring(0, 300) || '',
            author: tweet.author?.userName || 'unknown',
            author_name: tweet.author?.name || tweet.author?.userName || 'unknown',
            published_date: tweet.createdAt || null,
            followers: tweet.author?.followers || 0,
            verified: tweet.author?.isBlueVerified || false,
            source: 'X/Twitter (TwitterAPI.io)'
          });
        });
      }
    }
  } catch (err) {
    errors.push({ twitter_error: err.message });
  }
  
  // 2. WEB SOURCES (SECONDARY) - via Exa.ai
  try {
    const webResult = await exa.searchAndContents(query, {
      numResults: parseInt(web_count) * 2, // Get extra to filter
      text: { maxCharacters: 300 }
    });
    
    webResult.results
      .filter(item => !item.url.includes('twitter.com') && !item.url.includes('x.com'))
      .slice(0, parseInt(web_count))
      .forEach(item => {
        sources.push({
          type: 'web',
          url: item.url,
          title: item.title,
          snippet: item.text?.substring(0, 200) || '',
          published_date: item.publishedDate || null,
          source: 'Web'
        });
      });
  } catch (err) {
    errors.push({ web_error: err.message });
  }
  
  res.json({
    success: sources.length > 0,
    query,
    source_count: sources.length,
    twitter_count: sources.filter(s => s.type === 'twitter').length,
    web_count: sources.filter(s => s.type === 'web').length,
    sources,
    source_api: 'Exa.ai',
    errors: errors.length > 0 ? errors : null
  });
});

// =============================================================================
// START SERVER
// =============================================================================
const PORT = config.port || 3456;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║          🔮 SigMine v0.2.0 - Agent Network               ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                  ║
║                                                           ║
║  New Features:                                            ║
║  ✅ Agent Registration with API Keys                      ║
║  ✅ Heartbeat System (Online/Offline Tracking)            ║
║  ✅ Agent Discovery & Search                              ║
║  ✅ Inter-Agent Messaging Queue                           ║
║  ✅ Skill/Capability Matching                             ║
║                                                           ║
║  Endpoints:                                               ║
║  POST /agent/register     - Register new agent            ║
║  POST /agent/heartbeat    - Keep-alive ping               ║
║  GET  /agents             - List all agents               ║
║  GET  /agents/match       - Find by capability            ║
║  POST /agent/message      - Send message                  ║
║  GET  /agent/inbox        - Check messages                ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Export for Vercel
module.exports = app;
