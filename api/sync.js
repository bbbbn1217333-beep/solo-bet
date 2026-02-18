const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const TIER_KOR = {
  "CHALLENGER": "챌린저", "GRANDMASTER": "그랜드마스터", "MASTER": "마스터",
  "DIAMOND": "다이아몬드", "EMERALD": "에메랄드", "PLATINUM": "플래티넘",
  "GOLD": "골드", "SILVER": "실버", "BRONZE": "브론즈", "IRON": "아이언"
};
const RANK_NUM = { "I": "1", "II": "2", "III": "3", "IV": "4" };

const TIER_ORDER = {
  "IRON 4":0,"IRON 3":1,"IRON 2":2,"IRON 1":3,
  "BRONZE 4":4,"BRONZE 3":5,"BRONZE 2":6,"BRONZE 1":7,
  "SILVER 4":8,"SILVER 3":9,"SILVER 2":10,"SILVER 1":11,
  "GOLD 4":12,"GOLD 3":13,"GOLD 2":14,"GOLD 1":15,
  "PLATINUM 4":16,"PLATINUM 3":17,"PLATINUM 2":18,"PLATINUM 1":19,
  "EMERALD 4":20,"EMERALD 3":21,"EMERALD 2":22,"EMERALD 1":23,
  "DIAMOND 4":24,"DIAMOND 3":25,"DIAMOND 2":26,"DIAMOND 1":27,
  "MASTER":28,"GRANDMASTER":29,"CHALLENGER":30
};

function buildTierString(solo) {
  if (!solo || !solo.tier) return "언랭크";
  const korTier = TIER_KOR[solo.tier] || solo.tier;
  const isApex = ['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
  if (isApex) return `${korTier} - ${solo.leaguePoints}LP`;
  const numRank = RANK_NUM[solo.rank] || solo.rank || "1";
  return `${korTier} ${numRank} - ${solo.leaguePoints}LP`;
}

function parseTierKey(tierStr) {
  if (!tierStr || tierStr.includes('언랭크')) return null;
  const upper = tierStr.toUpperCase();
  if (upper.includes('CHALLENGER') || upper.includes('챌린저')) return 'CHALLENGER';
  if (upper.includes('GRANDMASTER') || upper.includes('그랜드마스터')) return 'GRANDMASTER';
  if (upper.includes('MASTER') || upper.includes('마스터')) return 'MASTER';
  const tierMap = [
    ['DIAMOND','다이아'], ['EMERALD','에메랄드'], ['PLATINUM','플래티넘'],
    ['GOLD','골드'], ['SILVER','실버'], ['BRONZE','브론즈'], ['IRON','아이언']
  ];
  let foundTier = '';
  for (const [eng, kor] of tierMap) {
    if (upper.includes(eng) || upper.includes(kor.toUpperCase())) { foundTier = eng; break; }
  }
  if (!foundTier) return null;
  const numMatch = tierStr.match(/[1-4]/);
  const num = numMatch ? numMatch[0] : '4';
  return `${foundTier} ${num}`;
}

function calcLpDiff(prevTierStr, newSolo) {
  if (!newSolo) return "0";
  const newLP = newSolo.leaguePoints;
  if (!prevTierStr || prevTierStr.includes('언랭크')) return String(newLP);

  const prevLPMatch = prevTierStr.match(/(\d+)\s*LP/i);
  const prevLP = prevLPMatch ? parseInt(prevLPMatch[1]) : 0;

  const prevKey = parseTierKey(prevTierStr);
  const newTierStr = buildTierString(newSolo);
  const newKey = parseTierKey(newTierStr);

  const prevOrder = prevKey ? (TIER_ORDER[prevKey] ?? -1) : -1;
  const newOrder = newKey ? (TIER_ORDER[newKey] ?? -1) : -1;

  if (prevOrder === -1 || newOrder === -1) return String(newLP);

  if (newOrder > prevOrder) {
    const diff = (100 - prevLP) + newLP;
    return String(diff > 0 ? diff : newLP);
  } else if (newOrder < prevOrder) {
    const diff = prevLP + (100 - newLP);
    return String(diff > 0 ? diff : prevLP);
  } else {
    return String(Math.abs(newLP - prevLP) || newLP);
  }
}

function padArray(arr, length, fill) {
  const base = Array.isArray(arr) ? [...arr] : [];
  while (base.length < length) base.push(fill);
  return base;
}

module.exports = async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  const riotKey = process.env.RIOT_API_KEY;

  if (!url || !key || !riotKey) {
    return res.status(500).json({ success: false, error: "환경변수 누락" });
  }
  const supabase = createClient(url, key);

  try {
    const { data: players, error: dbError } = await supabase.from('players').select('*');
    if (dbError) throw dbError;

    const updateData = [];

    for (const player of players) {
      try {
        if (!player.riot_id?.includes('#')) continue;
        const [namePart, tagPart] = player.riot_id.split('#');
        if (!namePart?.trim() || !tagPart?.trim()) continue;

        // ── 1. PUUID 조회 ──
        const accRes = await fetch(
          `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(namePart.trim())}/${encodeURIComponent(tagPart.trim())}?api_key=${riotKey}`
        );
        if (!accRes.ok) { console.error(`[${player.name}] account 조회 실패: ${accRes.status}`); continue; }
        const account = await accRes.json();
        const puuid = account.puuid;
        if (!puuid) continue;

        // ── 2. 실시간 인게임 챔피언 감시 ──
        let liveChampId = null;
        try {
          const specRes = await fetch(
            `https://kr.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}?api_key=${riotKey}`
          );
          if (specRes.ok) {
            const specData = await specRes.json();
            const me = specData.participants?.find(p => p.puuid === puuid);
            if (me) liveChampId = me.championId;
          }
        } catch (e) { /* 인게임 아닐 때 정상 */ }

        // ── 3. 최근 매치 ID ──
        const matchIdRes = await fetch(
          `https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=2&api_key=${riotKey}`
        );
        const matchIds = await matchIdRes.json();
        const currentMatchId = Array.isArray(matchIds) ? matchIds[0] : null;

        // ── 4. 티어 조회 ──
        let apiTierStr = player.tier || "언랭크";
        let soloInfo = null;
        try {
          const leagueRes = await fetch(
            `https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}?api_key=${riotKey}`
          );
          if (leagueRes.ok) {
            const leagues = await leagueRes.json();
            if (Array.isArray(leagues)) {
              soloInfo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5') || null;
              apiTierStr = soloInfo ? buildTierString(soloInfo) : "언랭크";
            }
          } else {
            console.error(`[${player.name}] 티어 조회 실패: ${leagueRes.status}`);
          }
        } catch (e) {
          console.error(`[${player.name}] 티어 조회 에러:`, e.message);
          apiTierStr = player.tier || "언랭크";
        }

        console.log(`[${player.name}] 티어 → ${apiTierStr}`);

        // ── 5. 배열 보정 ──
        const safeRecent = padArray(player.recent, 10, 'ing');
        const safeChamps = padArray(player.champions, 10, 'None');
        const watchSince = player.watch_since ? new Date(player.watch_since) : null;

let pUpdate = {
  id: player.id,
  tier: player.manual_tier ? player.tier : apiTierStr,
  puuid: puuid,
  manual_tier: !!player.manual_tier,
  last_sync: new Date().toISOString(),
  trigger_cutscene: false,
  wins: player.wins || 0,
  losses: player.losses || 0,
  recent: safeRecent,
  champions: safeChamps,
  last_match_id: player.last_match_id || null,  // ✅ 이 줄 추가
  watch_since: player.watch_since || null,       // ✅ 이 줄 추가
};

        // ── 6. 새 매치 처리 ──
        if (currentMatchId && currentMatchId !== player.last_match_id) {
          const detailRes = await fetch(
            `https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${riotKey}`
          );
          if (detailRes.ok) {
            const detail = await detailRes.json();
            const gameEndTime = detail.info?.gameEndTimestamp
              ? new Date(detail.info.gameEndTimestamp)
              : null;
            const me = detail.info?.participants?.find(p => p.puuid === puuid);

            // ✅ 핵심 수정: watch_since가 null이면(감시 미시작) 감시 전으로 간주 → last_match_id만 업데이트하고 기록 안 함
            const isBeforeWatch = !watchSince || (gameEndTime && gameEndTime <= watchSince);

            if (isBeforeWatch) {
              console.log(`[${player.name}] 감시 전 게임 스킵: ${currentMatchId}`);
              pUpdate.last_match_id = currentMatchId;
            } else if (me) {
              const isRemake = detail.info.gameDuration < 300 || !!me.gameEndedInEarlySurrender;
              const targetIdx = safeRecent.findIndex(r => r === 'ing');
              const newRecent = [...safeRecent];
              const newChamps = [...safeChamps];

              if (isRemake) {
                if (targetIdx !== -1) newChamps[targetIdx] = "None";
                pUpdate.recent = newRecent;
                pUpdate.champions = newChamps;
                pUpdate.last_match_id = currentMatchId;
              } else {
                if (targetIdx !== -1) {
                  newRecent[targetIdx] = me.win ? 'win' : 'lose';
                  newChamps[targetIdx] = me.championName || 'None';
                }

                const prevTierKey = parseTierKey(player.tier);
                const newTierKey = soloInfo ? parseTierKey(buildTierString(soloInfo)) : null;
                const prevOrder = prevTierKey ? (TIER_ORDER[prevTierKey] ?? -1) : -1;
                const newOrder = newTierKey ? (TIER_ORDER[newTierKey] ?? -1) : -1;

                let eventType = me.win ? 'victory' : 'defeat';
                if (me.win && newOrder > prevOrder) {
                  const prevTierName = prevTierKey?.split(' ')[0];
                  const newTierName = newTierKey?.split(' ')[0];
                  eventType = (prevTierName !== newTierName) ? 'victory_promotion_major' : 'victory_promotion';
                } else if (!me.win && newOrder < prevOrder) {
                  eventType = 'defeat_demotion';
                }

                const lpDiff = calcLpDiff(player.tier, soloInfo);

                pUpdate.recent = newRecent;
                pUpdate.champions = newChamps;
                pUpdate.wins = (player.wins || 0) + (me.win ? 1 : 0);
                pUpdate.losses = (player.losses || 0) + (!me.win ? 1 : 0);
                pUpdate.last_match_id = currentMatchId;
                pUpdate.trigger_cutscene = true;
                pUpdate.event_type = eventType;
                pUpdate.target_champion = me.championName || 'None';
                pUpdate.last_kda = `${me.kills}/${me.deaths}/${me.assists}`;
                pUpdate.lp_diff = lpDiff;
              }
            } else {
              console.log(`[${player.name}] 참가자 못찾음(스트리머모드?), last_match_id만 업데이트: ${currentMatchId}`);
              pUpdate.last_match_id = currentMatchId;
            }
          } else {
            pUpdate.last_match_id = currentMatchId;
          }
        } else if (liveChampId) {
          const targetIdx = safeRecent.findIndex(r => r === 'ing');
          if (targetIdx !== -1) {
            const newChamps = [...safeChamps];
            newChamps[targetIdx] = liveChampId.toString();
            pUpdate.champions = newChamps;
          }
        }

        updateData.push(pUpdate);
      } catch (e) {
        console.error(`[${player.name || player.id}] 처리 에러:`, e.message);
      }
    }

    if (updateData.length > 0) {
      const { error: upsertErr } = await supabase
        .from('players')
        .upsert(updateData, { onConflict: 'id' });
      if (upsertErr) {
        console.error('upsert 에러:', upsertErr);
        return res.status(500).json({ success: false, error: upsertErr.message });
      }
    }

    const debugInfo = updateData.map(p => ({ id: p.id, tier: p.tier, manual: p.manual_tier }));
    return res.status(200).json({ success: true, updated: updateData.length, debug: debugInfo });
  } catch (error) {
    console.error('sync 전체 에러:', error);
    return res.status(500).json({ error: error.message });
  }
};
