/** Data projections. Everything leaving the server goes through one of these. */
const id = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

const MYSTERY_NAME = 'Mystery Player';

function teamRef(t) {
  if (!t) return null;
  if (!t._id) return { id: String(t) };
  return { id: String(t._id), name: t.name, abbreviation: t.abbreviation, logo: t.logo };
}

function fullPlayer(p) {
  if (!p) return null;
  return {
    id: id(p), name: p.name, image: p.image, gender: p.gender, category: p.category,
    battingStyle: p.battingStyle, bowlingStyle: p.bowlingStyle, skills: p.skills, publicSkills: p.publicSkills,
    experience: p.experience, registrationId: p.registrationId, basePrice: p.basePrice,
    originalBasePrice: p.originalBasePrice, playerType: p.playerType, status: p.status,
    auctionOrder: p.auctionOrder, currentTeam: teamRef(p.currentTeam), purchasePrice: p.purchasePrice,
    resaleCount: p.resaleCount, unsoldCount: p.unsoldCount, skipCount: p.skipCount, identityHidden: false,
  };
}

/** Safe for anyone. MYSTERY identity (name, image, identifying profile, registration) is never included. */
function publicPlayer(p) {
  if (!p) return null;
  const common = {
    id: id(p), category: p.category, basePrice: p.basePrice, playerType: p.playerType, status: p.status,
    currentTeam: teamRef(p.currentTeam), purchasePrice: p.purchasePrice,
  };
  if (p.playerType === 'MYSTERY') {
    return { ...common, name: MYSTERY_NAME, image: null, skills: p.publicSkills || [], identityHidden: true };
  }
  return {
    ...common, name: p.name, image: p.image, gender: p.gender, battingStyle: p.battingStyle,
    bowlingStyle: p.bowlingStyle, skills: p.skills, experience: p.experience, identityHidden: false,
  };
}

/** For a captain: public view, plus the full profile of the one player their team revealed with its token. */
function captainPlayer(p, revealedPlayerId) {
  if (!p) return null;
  if (p.playerType === 'MYSTERY' && revealedPlayerId && id(p) === String(revealedPlayerId)) {
    const { registrationId, ...rest } = fullPlayer(p);
    return { ...rest, revealedToYou: true };
  }
  return publicPlayer(p);
}

function financeOf(t) {
  const spent = t.finance?.spent || 0;
  const resaleCredits = t.finance?.resaleCredits || 0;
  const squadCount = t.squad?.length || 0;
  return {
    initialPurse: t.initialPurse, totalSpent: spent, totalResaleCredits: resaleCredits,
    remainingPurse: t.initialPurse + resaleCredits - spent,
    playersPurchased: squadCount, playersRemaining: Math.max(t.maxSquadSize - squadCount, 0),
    maxSquadSize: t.maxSquadSize,
    squadCompletion: t.maxSquadSize ? Math.round((squadCount / t.maxSquadSize) * 100) : 0,
  };
}

function leaderboardRow(t) {
  return { ...teamRef(t), captainName: t.captain?.name || null, ...financeOf(t) };
}

module.exports = { fullPlayer, publicPlayer, captainPlayer, teamRef, financeOf, leaderboardRow, MYSTERY_NAME, id };
