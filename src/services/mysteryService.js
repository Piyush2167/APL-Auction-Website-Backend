const { MysteryToken, Player, Team } = require('../models');
const { getContext } = require('./seasonService');
const { conflict, forbidden } = require('../utils/errors');
const { audit } = require('./audit');
const { mutate } = require('./auctionService');
const outbox = require('./outbox');
const P = require('./projections');

/**
 * Consume the team's single season token to reveal the active MYSTERY player.
 * The identity goes back in this (authenticated) response and to the team's private room only.
 */
async function reveal(user) {
  return mutate(async (s) => {
    const { season, config, auction } = await getContext(s);
    if (!config.mysteryEnabled) throw conflict('MYSTERY_DISABLED', 'Mystery players are disabled');
    if (!user.team) throw forbidden('No team assigned');
    if (!auction.activePlayer) throw conflict('NO_ACTIVE_PLAYER', 'No player is up for auction');
    const player = await Player.findById(auction.activePlayer).session(s);
    if (player.playerType !== 'MYSTERY') throw conflict('NOT_MYSTERY', 'The current player is not a Mystery Player');
    const existing = await MysteryToken.findOne({ season: season._id, team: user.team }).session(s);
    if (!existing) throw conflict('TOKEN_NOT_ISSUED', 'Mystery tokens are issued when the auction starts');
    if (existing.status === 'USED') {
      if (String(existing.revealedPlayer) === String(player._id)) return { player: P.captainPlayer(player, player._id), alreadyRevealed: true };
      throw conflict('TOKEN_USED', 'Your team has already used its Mystery Token this season');
    }
    // Atomic consume: only one of any concurrent requests matches status AVAILABLE.
    const token = await MysteryToken.findOneAndUpdate(
      { _id: existing._id, status: 'AVAILABLE' },
      { $set: { status: 'USED', usedAt: new Date(), revealedPlayer: player._id, usedBy: user._id, meta: { auctionVersion: auction.version } } },
      { returnDocument: 'after', session: s },
    );
    if (!token) throw conflict('TOKEN_USED', 'Your team has already used its Mystery Token this season');
    const team = await Team.findById(user.team).select('name abbreviation logo').session(s);
    await audit(s, { season: season._id, type: 'MYSTERY_TOKEN_USED', actor: user, player: player._id, team: user.team });
    const revealed = P.captainPlayer(player, player._id);
    await outbox.enqueue(s, [
      { type: 'mystery:reveal', rooms: [`team:${user.team}`], payload: { player: revealed } },
      { type: 'team:updated', rooms: [`team:${user.team}`] },
      { type: 'mystery:token_used', rooms: ['admin'], payload: { team: P.teamRef(team), playerId: String(player._id) } },
    ]);
    return { player: revealed, alreadyRevealed: false };
  });
}

async function tokenUsage() {
  const { season } = await getContext();
  const tokens = await MysteryToken.find({ season: season._id }).populate('team', 'name abbreviation logo')
    .populate('revealedPlayer').populate('usedBy', 'name').lean();
  return tokens.map((t) => ({
    team: P.teamRef(t.team), status: t.status, usedAt: t.usedAt, usedBy: t.usedBy?.name || null,
    revealedPlayer: P.fullPlayer(t.revealedPlayer),
  }));
}

module.exports = { reveal, tokenUsage };
