'use strict';

const state = {
  httpActive: 0,
  httpTotal: 0,
  httpRejected: 0,
  blocksSaved: 0,
  blocksRejected: 0,
  duplicates: 0,
  lastBlockAt: null,
  ws: {
    connections: 0,
    users: 0,
    chats: 0,
    subscriptions: 0,
  },
};

function incHttpActive() {
  state.httpActive += 1;
  state.httpTotal += 1;
}

function decHttpActive() {
  state.httpActive = Math.max(0, state.httpActive - 1);
}

function incHttpRejected() {
  state.httpRejected += 1;
}

function incBlocksSaved() {
  state.blocksSaved += 1;
  state.lastBlockAt = new Date().toISOString();
}

function incBlocksRejected() {
  state.blocksRejected += 1;
}

function incDuplicates() {
  state.duplicates += 1;
}

function setWs(partial) {
  state.ws = {
    ...state.ws,
    ...partial,
  };
}

function snapshot() {
  return {
    http: {
      active: state.httpActive,
      total: state.httpTotal,
      rejected: state.httpRejected,
    },
    blocks: {
      saved: state.blocksSaved,
      rejected: state.blocksRejected,
      duplicates: state.duplicates,
      lastAt: state.lastBlockAt,
    },
    ws: { ...state.ws },
    memory: {
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
    },
    uptime: Math.floor(process.uptime()),
    pid: process.pid,
  };
}

module.exports = {
  incHttpActive,
  decHttpActive,
  incHttpRejected,
  incBlocksSaved,
  incBlocksRejected,
  incDuplicates,
  setWs,
  snapshot,
};
