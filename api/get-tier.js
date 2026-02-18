// ✅ [수정] sync.js와 완전히 동일한 티어 형식 사용
// 형식: "골드 1 - 45LP" (한글 + 숫자 단계 + 하이픈 + LP)

const TIER_KOR = {
  "CHALLENGER": "챌린저", "GRANDMASTER": "그랜드마스터", "MASTER": "마스터",
  "DIAMOND": "다이아몬드", "EMERALD": "에메랄드", "PLATINUM": "플래티넘",
  "GOLD": "골드", "SILVER": "실버", "BRONZE": "브론즈", "IRON": "아이언"
};

// 로마자 → 숫자
const RANK_NUM = { "I": "1", "II": "2", "III": "3", "IV": "4" };

function buildTierString(solo) {
  if (!solo) return "언랭크";
  const korTier = TIER_KOR[solo.tier] || solo.tier;
  const isApex = ['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
  if (isApex) {
    return `${korTier} - ${solo.leaguePoints}LP`;
  }
  const numRank = RANK_NUM[solo.rank] || solo.rank;
  return `${korTier} ${numRank} - ${solo.leaguePoints}LP`;
}

export default async function handler(req, res) {
  const { name, tag } = req.query;
  const RIOT_KEY = process.env.RIOT_API_KEY;

  if (!name || !tag) {
    return res.status(400).json({ success: false, error: "닉네임#태그를 확인해주세요." });
  }

  try {
    // 1. PUUID 조회
    const accRes = await fetch(
      `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${RIOT_KEY}`
    );
    if (accRes.status === 403) throw new Error('API KEY EXPIRED');
    if (accRes.status === 404) throw new Error('ID NOT FOUND');
    const accData = await accRes.json();
    const puuid = accData.puuid;
    if (!puuid) throw new Error('NO PUUID');

    // 2. 최근 매치 ID 조회
    const matchRes = await fetch(
      `https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1&api_key=${RIOT_KEY}`
    );
    const matchIds = await matchRes.json();
    const lastMatchId = (Array.isArray(matchIds) && matchIds.length > 0) ? matchIds[0] : "NO_MATCH";

    // 3. 티어 조회 (PUUID 기반으로 변경 - Summoner ID 단계 생략)
    const leaRes = await fetch(
      `https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}?api_key=${RIOT_KEY}`
    );
    const leaData = await leaRes.json();

    let tierString = "언랭크";
    if (Array.isArray(leaData)) {
      const solo = leaData.find(e => e.queueType === 'RANKED_SOLO_5x5');
      // ✅ sync.js와 동일한 buildTierString 함수 사용
      tierString = buildTierString(solo);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      success: true,
      tier: tierString,    // 예: "골드 1 - 45LP"
      lastMatchId: lastMatchId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message.toUpperCase() });
  }
}



