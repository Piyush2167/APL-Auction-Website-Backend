// ponytail: in-memory presence, correct for one instance. Multi-instance needs Redis-backed counts.
const state = { audience: 0, captains: new Map(), admins: 0 };

function add(role, userId) {
  if (role === 'CAPTAIN') state.captains.set(userId, (state.captains.get(userId) || 0) + 1);
  else if (role === 'ADMIN') state.admins += 1;
  else state.audience += 1;
}

function remove(role, userId) {
  if (role === 'CAPTAIN') {
    const n = (state.captains.get(userId) || 1) - 1;
    if (n <= 0) state.captains.delete(userId); else state.captains.set(userId, n);
  } else if (role === 'ADMIN') state.admins = Math.max(state.admins - 1, 0);
  else state.audience = Math.max(state.audience - 1, 0);
}

const counts = () => ({ audience: state.audience, captains: state.captains.size, admins: state.admins });

module.exports = { add, remove, counts };
