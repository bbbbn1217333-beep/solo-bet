// api/get-tier.js
export default async function handler(req, res) {
  const { name, tag } = req.query;
  const RIOT_KEY = process.env.RIOT_API_KEY; // Vercel 설정에서 넣을 값

  if (!name || !tag) {
    return res.status(400).json({ success: false, error: "닉네임#태그를 확인해주세요." });
  }

  try {
    // 1. Account-v1: PUUID 조회
    const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${RIOT_KEY}`);
    const accData = await accRes.json();
    if (!accData.puuid) throw new Error('계정을 찾을 수 없습니다.');

    // 2. Summoner-v4: Summoner ID 조회
    const sumRes = await fetch(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${accData.puuid}?api_key=${RIOT_KEY}`);
    const sumData = await sumRes.json();

    // 3. League-v4: 티어 정보 조회
    const leaRes = await fetch(`https://kr.api.riotgames.com/lol/league/v1/entries/by-summoner/${sumData.id}?api_key=${RIOT_KEY}`);
    const leaData = await leaRes.json();

    // 솔로 랭크 데이터 추출
    const solo = leaData.find(e => e.queueType === 'RANKED_SOLO_5x5');
    
    let tierString = "UNRANKED";
    if (solo) {
      // 마스터 이상은 단계(IV 등)가 없으므로 처리
      const hasRank = !['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
      tierString = `${solo.tier}${hasRank ? ' ' + solo.rank : ''} - ${solo.leaguePoints}LP`;
    }

    res.status(200).json({ success: true, tier: tierString });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}