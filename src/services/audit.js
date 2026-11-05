const { AuctionLog } = require('../models');

/** Append an audit record (inside the caller's transaction when a session is given). */
async function audit(session, { season, type, actor, player, team, previousState, newState, details }) {
  await AuctionLog.create([{
    season, type, actor: actor?._id || null, actorRole: actor?.role || 'SYSTEM',
    player, team, previousState, newState, details,
  }], { session });
}

module.exports = { audit };
