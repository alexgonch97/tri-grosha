/* ==========================================================================
   game.js — Game logic for "Three Pennies Inn" (Zonk / Farkle)
   All 6 playtest fixes applied.
   ========================================================================== */

/* --------------------------------------------------------------------------
   1. Сезон 1: реферальный API-сервер (Cloudflare Worker)
   Пока в адресе стоит YOUR_SUBDOMAIN — игра работает в офлайн-режиме:
   все вызовы сети аккуратно пропускаются, интерфейс остаётся рабочим.
   -------------------------------------------------------------------------- */
const REF_API_URL = 'https://trigrosha-ref.alalalgogogo.workers.dev';
function isRefApiReady() {
  return typeof REF_API_URL === 'string' && REF_API_URL.length > 0 && !REF_API_URL.includes('YOUR_SUBDOMAIN');
}

/* --------------------------------------------------------------------------
   2. Telegram WebApp Integration & Haptic Feedback
   -------------------------------------------------------------------------- */
const tg = window.Telegram?.WebApp;
if (tg) { try { tg.expand(); tg.ready(); } catch (e) {} }

function triggerHaptic(type = 'impact', style = 'medium') {
  if (tg?.HapticFeedback) {
    if (type === 'impact') tg.HapticFeedback.impactOccurred(style);
    else if (type === 'notification') tg.HapticFeedback.notificationOccurred(style);
  }
}

const playerName = tg?.initDataUnsafe?.user?.first_name
  || tg?.initDataUnsafe?.user?.username
  || 'Путник';
/* --------------------------------------------------------------------------
   2b. Economy: gold, wins, wallet (localStorage)
   -------------------------------------------------------------------------- */
const STORAGE_KEYS = {
  gold: 'trigrosha_s1_gold', wins: 'trigrosha_s1_wins', quests: 'trigrosha_s1_daily_quests',
  upgrades: 'trigrosha_s1_upgrades', diceOwned: 'trigrosha_s1_dice_owned',
  diceEquipped: 'trigrosha_s1_dice_equipped', aiSpeed: 'trigrosha_s1_ai_speed',
  activeMatch: 'trigrosha_s1_active_match',
  promos: 'trigrosha_s1_promos', referral: 'trigrosha_s1_referral',
  friends: 'trigrosha_s1_friends', achievements: 'trigrosha_s1_achievements',
  refPaidTotal: 'trigrosha_s1_ref_paid_total', welcomePaid: 'trigrosha_s1_welcome_paid'
};
const START_GOLD = 100;

/* --------------------------------------------------------------------------
   2b-1. Сезон 1: версия сохранения (SAVE_EPOCH)
   Смена SAVE_EPOCH полностью стирает прогресс игрока — и в localStorage,
   и в Telegram CloudStorage, — чтобы сезон начинался с чистого листа.
   -------------------------------------------------------------------------- */
const SAVE_EPOCH = 's1_wipe_1';
const EPOCH_STORAGE_KEY = 'trigrosha_save_epoch';

/* --------------------------------------------------------------------------
   2b-2. Сезон 1: фоновая синхронизация прогресса с Telegram CloudStorage
   Кошель, победы, обустройство, кости, дейлики, промокоды и рефералы
   дублируются в облако Telegram (поверх localStorage).
   -------------------------------------------------------------------------- */
const CLOUD_SYNC_KEYS = [
  STORAGE_KEYS.gold, STORAGE_KEYS.wins, STORAGE_KEYS.upgrades, STORAGE_KEYS.diceOwned,
  STORAGE_KEYS.diceEquipped, STORAGE_KEYS.quests, STORAGE_KEYS.promos, STORAGE_KEYS.referral,
  STORAGE_KEYS.friends, STORAGE_KEYS.achievements,
  STORAGE_KEYS.refPaidTotal, STORAGE_KEYS.welcomePaid
];
const cloudStorage = tg?.CloudStorage || null;
const localKeysAtBoot = new Set();
try { CLOUD_SYNC_KEYS.forEach(k => { try { if (localStorage.getItem(k) !== null) localKeysAtBoot.add(k); } catch (e) {} }); } catch (e) {}
/* --- Управляемый сброс прогресса по версии сезона -------------------------
   Если сохранённая эпоха не совпадает с SAVE_EPOCH — чистим все ключи
   прогресса локально и в облаке, сбрасываем localKeysAtBoot и фиксируем
   новую эпоху (заодно дублируя её в CloudStorage).                        */
(function applySaveEpoch() {
  let storedEpoch = null;
  try { storedEpoch = localStorage.getItem(EPOCH_STORAGE_KEY); } catch (e) {}
  if (storedEpoch === SAVE_EPOCH) return;
  const wipeKeys = Object.values(STORAGE_KEYS).concat(['trigrosha_s1_ref_paid_total', 'trigrosha_s1_welcome_paid']);
  wipeKeys.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
  if (cloudStorage) wipeKeys.forEach(k => { try { cloudStorage.removeItem(k, () => {}); } catch (e) {} });
  localKeysAtBoot.clear(); // чтобы syncCloudProgress() не восстановил старые значения до записи новой эпохи
  try { localStorage.setItem(EPOCH_STORAGE_KEY, SAVE_EPOCH); } catch (e) {}
  if (cloudStorage) { try { cloudStorage.setItem(EPOCH_STORAGE_KEY, SAVE_EPOCH, () => {}); } catch (e) {} }
})();
let cloudReady = false;
function cloudSet(key, value) { if (!cloudStorage || !cloudReady) return; try { cloudStorage.setItem(key, String(value), () => {}); } catch (e) {} }
function cloudGetItems(keys, cb) { if (!cloudStorage) { cb({}); return; } try { cloudStorage.getItems(keys, (err, data) => { cb(err || !data ? {} : data); }); } catch (e) { cb({}); } }

let gold = parseInt(localStorage.getItem(STORAGE_KEYS.gold), 10);
if (!Number.isFinite(gold)) { gold = START_GOLD; localStorage.setItem(STORAGE_KEYS.gold, String(gold)); }
let winsCount = parseInt(localStorage.getItem(STORAGE_KEYS.wins) || '0', 10) || 0;

function flashGold() {
  const badge = document.getElementById('goldBadge');
  badge.classList.remove('flash'); void badge.offsetWidth; badge.classList.add('flash');
}

function updateHeader() {
  document.getElementById('headerPlayerName').textContent = playerName;
  document.getElementById('userSub').textContent = `Победы: ${winsCount}`;
  document.getElementById('goldValue').textContent = gold;
  document.getElementById('playerName').textContent = playerName;
}

function addGold(amount, withSound = false) {
  gold = Math.max(0, gold + amount);
  localStorage.setItem(STORAGE_KEYS.gold, String(gold));
  cloudSet(STORAGE_KEYS.gold, String(gold));
  updateHeader();
  if (withSound && amount > 0) { soundManager.playCoin(); flashGold(); }
  if (gold >= 1000) unlockAch('rich_purse');
  if (document.getElementById('tavernScreen').classList.contains('active')) renderTavern();
  if (document.getElementById('upgradeModal').classList.contains('active')) renderUpgrades();
  if (document.getElementById('diceShopModal').classList.contains('active')) renderDiceShop();
}
/* --------------------------------------------------------------------------
   2c. Opponents (part 1/2)
   -------------------------------------------------------------------------- */
const OPPONENTS = [
  { id:'sivka', name:'Сивка', fullName:'Конюх Сивка', title:'Крылатый конюх', avatar:'🐴', photo:'assets/npc-sivka.png', bet:10, styleType:'reckless', joke:['Крыша сарая худая, зато кости с высоты виднее!','Пока мерин жуёт, я на крышу — и оттуда кидаю.','Мне бы дров наколоть, а я тут гроши собираю…'], svg:'<svg viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="svs-bg" cx="50%" cy="30%" r="78%"><stop offset="0" stop-color="#6b4a26"/><stop offset="1" stop-color="#1a1009"/></radialGradient><linearGradient id="svs-hat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2dc9f"/><stop offset="1" stop-color="#b98f43"/></linearGradient></defs><rect width="64" height="64" fill="url(#svs-bg)"/><path d="M6 64c2-13 12-19 26-19s24 6 26 19z" fill="#3f5d2a"/><path d="M6 64c2-13 12-19 26-19s24 6 26 19z" fill="none" stroke="#8fae74" stroke-width="1"/><circle cx="32" cy="29" r="12" fill="#e6c79a"/><path d="M19 25c1-9 6-13 13-13s12 4 13 13c-3-4-8-5-13-5s-10 1-13 5z" fill="#6b4223"/><path d="M22 18c1-7 5-10 10-10s9 3 10 10z" fill="url(#svs-hat)"/><ellipse cx="32" cy="19" rx="18" ry="4.2" fill="url(#svs-hat)"/><circle cx="27" cy="30" r="1.7" fill="#3b2415"/><circle cx="37" cy="30" r="1.7" fill="#3b2415"/><path d="M27 36c3 2 7 2 10 0" stroke="#3b2415" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M26 53c0-4 2.6-6.5 6-6.5s6 2.5 6 6.5" fill="none" stroke="#e0bc4e" stroke-width="2.2" stroke-linecap="round"/></svg>', style:'Безрассудный: бросает, пока не наберёт 500+ очков за ход', lines:{start:['Опять на крышу сарая залез — оттуда и кидаю наугад!','С крыши-то всё видно, потому и кидаю как придётся!'],luck:['Гляди, с крыши и кости виднее!','Ох ты, свезло, ровно ветру в поле!'],risky:['Сарай не сарай, а кидаю ещё!','Наугад, да с размаху!'],bank:['Пора слезать — своё забираю.','Вниз, вниз, покуда кости целы!'],zonk:['Кувырк с крыши — и пусто!','Опять я на земле, а кости мимо.'],win:['Вот так с крыши — и все твои гроши!','Сивка с высоты всех обглядел!'],lose:['Ну и ладно, залезу на крышу снова.','Ох, слезать придётся пустым.']}},
  { id:'ignat', name:'Игнат', fullName:'Голодный Игнат', title:'Сын кузнеца', avatar:'🍲', photo:'assets/npc-ignat.png', bet:30, styleType:'balanced', joke:['В животе урчит так, что кости подпрыгивают!','Щи дадут — и я добрый. Не дадут — тоже добрый, но злой.','Кузнец я или нет? Кую удачу, а она не куётся…'], svg:'<svg viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="ign-bg" cx="50%" cy="30%" r="78%"><stop offset="0" stop-color="#5c4a2a"/><stop offset="1" stop-color="#150e09"/></radialGradient></defs><rect width="64" height="64" fill="url(#ign-bg)"/><path d="M7 64c2-13 12-19 25-19s23 6 25 19z" fill="#6d6157"/><path d="M20 46h24l-2 18H22z" fill="#8a7a68" opacity="0.85"/><circle cx="32" cy="30" r="12" fill="#e8cda4"/><path d="M20 26c1-9 6-13 12-13s11 4 12 13c-3-4-7-5-12-5s-9 1-12 5z" fill="#2f2419"/><circle cx="27" cy="31" r="1.7" fill="#2f2419"/><circle cx="37" cy="31" r="1.7" fill="#2f2419"/><path d="M27 37c3 2 7 2 10 0" stroke="#2f2419" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M44 13h14l-1.6 9.4a5.6 5.6 0 0 1-10.8 0z" fill="#4b4b52" stroke="#2a2a30" stroke-width="1.2"/><path d="M42.5 13h17" stroke="#9aa0a8" stroke-width="2.2" stroke-linecap="round"/></svg>', style:'Уравновешенный: забирает банк от 300–350 очков', lines:{start:['В животе урчит, а ну как щи накидаются?','Сыграем, а после — миска густых щей.'],luck:['Ишь, прёт — глядишь, и до щей доживу!','Ещё чуток, и на щи хватит!'],risky:['Живот не терпит, кидаю!','Щи сами себя не наварят!'],bank:['Всё, на щи хватит, забираю.','Хватит рисковать — есть охота.'],zonk:['Урчит пуще прежнего — а пусто!','Ни щей, ни очков…'],win:['Эх, наварю теперь густых щей!','Сын кузнеца и голоден, и при грошах!'],lose:['Ладно, и без щей потерплю.','Брюхо подвело, да не беда.']}},
{ id:'yashka', name:'Яшка', fullName:'Гусельник Яшка', title:'Уездный балагур', avatar:'🪕', photo:'assets/npc-yashka.png', bet:80, styleType:'cautious', joke:['Гусли врут, но кости врут красивее!','Про тебя спою — да так, что весь уезд поверит.','Монетку кинешь? А я про тебя потешку сложу.'], svg:'<svg viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="yas-bg" cx="50%" cy="30%" r="78%"><stop offset="0" stop-color="#4a3a5e"/><stop offset="1" stop-color="#150e14"/></radialGradient><linearGradient id="yas-gus" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe9a8"/><stop offset="1" stop-color="#b8860b"/></linearGradient></defs><rect width="64" height="64" fill="url(#yas-bg)"/><path d="M7 64c2-13 12-19 25-19s23 6 25 19z" fill="#6a2f3a"/><circle cx="32" cy="29" r="12" fill="#eccfa8"/><path d="M20 27c0-9 5-14 12-14s12 5 12 14c-3-5-7-6-12-6s-9 1-12 6z" fill="#4a3520"/><path d="M14 21c6-2 12-1 18 1 6-2 12-3 18-1l-2-6c-6-2-11-1-16 1-5-2-10-3-16-1z" fill="#3a2a1a"/><circle cx="27" cy="30" r="1.7" fill="#3b2415"/><circle cx="37" cy="30" r="1.7" fill="#3b2415"/><path d="M24 34c3-2 5-2 8 0 3-2 5-2 8 0" fill="none" stroke="#5a4026" stroke-width="1.9" stroke-linecap="round"/><path d="M12 47c8-6 32-6 40 0l-4 9c-8-4-24-4-32 0z" fill="url(#yas-gus)" stroke="#7a5a1e" stroke-width="1.3"/><path d="M16 49h32" stroke="#7a5a1e" stroke-width="1"/><path d="M17 53h30" stroke="#7a5a1e" stroke-width="1"/></svg>', style:'Осторожный тактик: рискует, только когда отстаёт по очкам', lines:{start:['Гусляр играет — монета звенит! Потягаемся?','Кинь звонкую монету, путник!'],luck:['Вот так потешка на весь уезд!','Звени, монета, звени!'],risky:['Ради потешки и рискну!','Пусть уезд посмеётся — кидаю!'],bank:['Хватит на гуслярский звон, забираю.','Монета в кошель — и с поклоном.'],zonk:['Ох, и потешка вышла — пусто!','Струны-то врут, и кости туда же.'],win:['Про меня на весь уезд споют!','Гусляр тебе и потешку, и монету.'],lose:['Спою про тебя — да не зло.','Ещё споём, путник, ещё!']}},
  { id:'lovchiy', name:'Ловчий', fullName:'Седой Ловчий', title:'Охотник на нечисть', avatar:'🏹', photo:'assets/npc-hunter.png', bet:150, styleType:'gambler', joke:['Ненавижу азарт. Кидай.','Волков бил. С костями как-то сложнее.','Хм. Только не жульничай. Я по следам читаю.'], svg:'<svg viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="lov-bg" cx="50%" cy="30%" r="78%"><stop offset="0" stop-color="#3a4a52"/><stop offset="1" stop-color="#0e1418"/></radialGradient></defs><rect width="64" height="64" fill="url(#lov-bg)"/><path d="M32 8c11 0 16 9 16 19v12c0 10-7 16-16 16s-16-6-16-16V27c0-10 5-19 16-19z" fill="#39424a"/><path d="M32 8c11 0 16 9 16 19" fill="none" stroke="#5e6a74" stroke-width="1.4"/><circle cx="32" cy="31" r="10.5" fill="#e2c39c"/><path d="M32 41c-6 0-9.5 4-9.5 10h19c0-6-3.5-10-9.5-10z" fill="#c3c0ba"/><path d="M22 28c1-7 5-10 10-10s9 3 10 10c-2-3-5-4-10-4s-8 1-10 4z" fill="#cfd3d8"/><circle cx="28" cy="30" r="1.6" fill="#2f2419"/><circle cx="36" cy="30" r="1.6" fill="#2f2419"/><path d="M11 14c-5 12-5 24 0 36" fill="none" stroke="#8a5a2a" stroke-width="2.8" stroke-linecap="round"/><path d="M11 15v34" stroke="#efe9d6" stroke-width="1"/></svg>', style:'Мастер риска: агрессивен в концовке, любит «1» и «5»', lines:{start:['Хм. Кидай.','Ненавижу азарт. Ходи.'],luck:['Хм… Годится.','Нечисть бы так шла.'],risky:['Хм. Ещё раз.','Рискну. Без охоты.'],bank:['Беру. Довольно.','Хм. В кошель.'],zonk:['Хм… Зараза.','Пусто. Ненавижу азарт.'],win:['Хм. Ненавижу азарт. Но выиграл.','Забирай своё и уйди.'],lose:['Хм. Твоя взяла.','Довольно. Ухожу.']}}
];
/* --------------------------------------------------------------------------
   2c-2. Tavern Hall: NPC medallions, scroll card, live decor
   -------------------------------------------------------------------------- */
let selectedNpcId = null, previewNpcId = null, cardJoke = '';

function renderOpponents() {
  const layer = document.getElementById('npcLayer'); if (!layer) return;
  layer.innerHTML = '';
  OPPONENTS.forEach(opp => {
    const affordable = gold >= opp.bet;
    const spot = document.createElement('button'); spot.type = 'button';
    spot.dataset.npc = opp.id;
    spot.className = 'npc-spot npc-' + opp.id + (affordable ? '' : ' locked') + (selectedNpcId === opp.id ? ' selected' : '');
    spot.setAttribute('aria-label', opp.fullName + ' — ставка ' + opp.bet + ' грошей');
    spot.innerHTML = '<span class="npc-hit" aria-hidden="true"></span><img class="npc-sprite" src="' + opp.photo + '" alt="' + opp.fullName + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\'">' + opp.svg.replace('<svg ', '<svg class="npc-svg-fallback" style="display:none" ') + '<span class="npc-plate"><span class="npc-plate-name">' + opp.name + '</span><span class="npc-plate-bet">' + opp.bet + ' 🪙</span></span>';
    spot.addEventListener('click', () => onNpcClick(opp));
    layer.appendChild(spot);
  });
}

function highlightNpc(id) { document.querySelectorAll('.npc-spot').forEach(el => el.classList.toggle('selected', Boolean(id) && el.dataset.npc === id)); }
function selectNpc(opp, withSound) { if (selectedNpcId !== opp.id) cardJoke = ''; selectedNpcId = opp.id; previewNpcId = opp.id; highlightNpc(opp.id); showNpcCard(opp); if (withSound) { soundManager.init(); soundManager.playSelect(); triggerHaptic('impact', 'light'); } }
function closeNpcScroll() { clearNpcSelection(); }
function onNpcClick(opp) { if (matchState === 'playing') return; if (selectedNpcId === opp.id) { closeNpcScroll(); return; } selectNpc(opp, true); }

function showNpcCard(opp) {
  const card = document.getElementById('npcScroll'); if (!card || !opp) return;
  /* Положение свитка задаётся только в style.css — снимаем возможные инлайн-координаты */
  card.style.left = ''; card.style.top = ''; card.style.right = ''; card.style.bottom = ''; card.style.transform = '';
  const affordable = gold >= opp.bet;
  if (!cardJoke) cardJoke = (opp.joke && opp.joke.length) ? opp.joke[Math.floor(Math.random() * opp.joke.length)] : '';
  card.className = 'npc-scroll show';
  card.innerHTML = '<div class="scroll-head"><span class="scroll-name">' + opp.fullName + '</span><span class="scroll-title">' + opp.title + '</span></div>' + (cardJoke ? '<p class="scroll-line">«' + cardJoke + '»</p>' : '') + '<div class="scroll-bet"><span>Ставка:</span><strong>' + opp.bet + ' 🪙</strong></div><button type="button" class="btn btn-primary scroll-play"' + (affordable ? '' : ' disabled') + '>Сыграть (' + opp.bet + ' грошей)</button>' + (affordable ? '<div class="scroll-tip">Нажмите «Сыграть», чтобы начать партию.</div>' : '<div class="scroll-hint">В кошеле лишь ' + gold + ' грошей — попросите милостыню у входа.</div>');
  const playBtn = card.querySelector('.scroll-play'); if (playBtn && affordable) playBtn.addEventListener('click', () => startMatch(opp));
  const hint = document.getElementById('hallHint'); if (hint) hint.classList.add('hidden');
}
function hideNpcCard() { const card = document.getElementById('npcScroll'); if (card) { card.classList.remove('show'); card.innerHTML = ''; } }
function refreshNpcCard() { if (!selectedNpcId) return; const opp = OPPONENTS.find(o => o.id === selectedNpcId); if (opp) showNpcCard(opp); }
function clearNpcSelection() { selectedNpcId = null; previewNpcId = null; cardJoke = ''; hideNpcCard(); highlightNpc(null); }

document.getElementById('hallScene').addEventListener('click', (e) => {
  if (e.target.closest('.npc-spot') || e.target.closest('.npc-scroll')) return;
  if (!selectedNpcId && !previewNpcId) return; clearNpcSelection();
});
/* --------------------------------------------------------------------------
   2c-3. Live Hall & Table Decor + float scores
   -------------------------------------------------------------------------- */
const HALL_CANDLE_SPOTS = [{ x:24,y:30,s:1.0,stand:false },{ x:46,y:21,s:1.15,stand:true },{ x:70,y:33,s:0.95,stand:false },{ x:13,y:58,s:0.9,stand:true },{ x:86,y:62,s:0.95,stand:false }];
const TABLE_CANDLE_SPOTS = [{ x:6,y:7,s:0.8,stand:false },{ x:92,y:11,s:0.85,stand:false },{ x:6,y:78,s:0.8,stand:false },{ x:92,y:80,s:0.85,stand:false }];
function candleMarkup(spot, index) { return '<span class="candle'+(spot.stand?' with-stand':'')+'" style="left:'+spot.x+'%;top:'+spot.y+'%;--sc:'+spot.s+';--cd:'+(index*0.37).toFixed(2)+'s"><i class="cup"></i></span>'; }
function sparkMarkup(count, spots) { let out=''; for(let i=0;i<count;i++){ const spot=spots[i%spots.length]; out+='<span class="spark" style="left:'+spot.x+'%;top:'+spot.y+'%;margin-left:'+(Math.random()*26-13).toFixed(1)+'px;margin-top:'+(Math.random()*14-7).toFixed(1)+'px;--sd:'+(Math.random()*3.4).toFixed(2)+'s"></span>'; } return out; }
let hallDecorBuilt = false;
function renderHallDecor() { if(hallDecorBuilt)return; hallDecorBuilt=true; const hc=document.getElementById('hallCandles'),hs=document.getElementById('hallSparks'),tc=document.getElementById('tableCandles'); if(hc)hc.innerHTML=HALL_CANDLE_SPOTS.map(candleMarkup).join(''); if(hs)hs.innerHTML=sparkMarkup(14,HALL_CANDLE_SPOTS); if(tc)tc.innerHTML=TABLE_CANDLE_SPOTS.map(candleMarkup).join('')+sparkMarkup(6,TABLE_CANDLE_SPOTS); }
function spawnFloatScore(text, container) { if(!container)return; const el=document.createElement('span'); el.className='float-score'; el.textContent=text; container.appendChild(el); setTimeout(()=>el.remove(),1200); }
function updateBegButton() { document.getElementById('begBtn').style.display = gold < 10 ? 'flex' : 'none'; const hint = document.getElementById('promoHint'); if (hint) hint.style.display = gold < 10 ? 'block' : 'none'; }
function renderTavern() { renderHallDecor(); updateHeader(); renderOpponents(); renderQuestBadge(); updateBegButton(); renderUpgradeButton(); renderAchBadge(); refreshNpcCard(); }

/* --------------------------------------------------------------------------
   2h. Progression: Inn Upgrades
   -------------------------------------------------------------------------- */
const UPGRADES = [
  { id:'candles', name:'Сальные свечи и шандал', desc:'Яркие мерцающие свечи с золотым ореолом и летящими искрами.', cost:150, cls:'upg-candles' },
  { id:'oak', name:'Дубовая стойка и бочонки', desc:'Резная дубовая рама с золотыми заклёпками вокруг зала и стола.', cost:400, cls:'upg-oak' },
  { id:'cloth', name:'Зелёное сукно с золотым шитьём', desc:'Изумрудное игровое полотно с золотой вышивкой поверх дубового стола.', cost:800, cls:'upg-cloth' },
  { id:'crest', name:'Уездная грамота и герб', desc:'Герб над названием, золотая корона и пропуск в Сезон 2.', cost:1500, cls:'upg-crest' }
];
function loadUpgrades() { let s=[]; try{s=JSON.parse(localStorage.getItem(STORAGE_KEYS.upgrades)||'[]')}catch(e){s=[]} if(!Array.isArray(s))s=[]; const r=[]; for(const u of UPGRADES){if(s.includes(u.id))r.push(u.id);else break;} return r; }
let purchasedUpgrades = loadUpgrades();
function saveUpgrades() { localStorage.setItem(STORAGE_KEYS.upgrades, JSON.stringify(purchasedUpgrades)); cloudSet(STORAGE_KEYS.upgrades, JSON.stringify(purchasedUpgrades)); }
function isUpgradeBought(id) { return purchasedUpgrades.includes(id); }
function nextUpgrade() { return UPGRADES.find(u => !isUpgradeBought(u.id)) || null; }
function applyUpgrades() { const app=document.getElementById('app'); UPGRADES.forEach(u => app.classList.toggle(u.cls, isUpgradeBought(u.id))); }
function renderUpgradeButton() { const btn=document.getElementById('upgradeBtn'); if(!btn)return; btn.textContent='🏠 Обустройство ('+purchasedUpgrades.length+'/4)'; }
function renderUpgrades() { const list=document.getElementById('upgradeList'); if(!list)return; const next=nextUpgrade(); list.innerHTML=''; UPGRADES.forEach(u=>{ const bought=isUpgradeBought(u.id),isNext=!bought&&next&&next.id===u.id,affordable=gold>=u.cost; const item=document.createElement('div'); item.className='shop-item'+(bought?' done':''); item.innerHTML='<div class="shop-info"><div class="shop-name">'+u.name+'</div><div class="shop-desc">'+u.desc+'</div><div class="shop-cost">'+(bought?'<span class="tag-ok">✔ Обустроено</span>':u.cost+' 🪙')+'</div></div>'; const btn=document.createElement('button');btn.type='button';btn.className='shop-btn'+(bought?'':' buy');btn.textContent=bought?'Готово':(isNext?'Купить':'По порядку');btn.disabled=bought||!isNext||!affordable;if(isNext)btn.addEventListener('click',()=>buyUpgrade(u.id));item.appendChild(btn);list.appendChild(item);}); }
function buyUpgrade(id) { const u=UPGRADES.find(u=>u.id===id),n=nextUpgrade(); if(!u||!n||n.id!==id||isUpgradeBought(id))return; if(gold<u.cost){showToast('Нужно '+u.cost+' грошей, а в кошеле лишь '+gold+'.');triggerHaptic('notification','error');return;} soundManager.init();addGold(-u.cost);purchasedUpgrades.push(u.id);saveUpgrades();applyUpgrades();renderUpgrades();renderUpgradeButton();raiseAch('inn_master', purchasedUpgrades.length);soundManager.playCoin();triggerHaptic('notification','success');showToast('Обустроено: «'+u.name+'»!'); }
/* --------------------------------------------------------------------------
   2i. Special Dice Shop
   -------------------------------------------------------------------------- */
const DICE_TYPES = { ordinary:{id:'ordinary',name:'Обычная костяная',desc:'Равные шансы на 1–6.',cost:0,preview:'preview-ordinary',weights:{1:1,2:1,3:1,4:1,5:1,6:1}}, odd:{id:'odd',name:'Нечётная кость',desc:'Повышенный шанс на 1, 3 и 5. Тёмный оттенок.',cost:120,preview:'preview-odd',weights:{1:2,2:1,3:2,4:1,5:2,6:1}}, merchant:{id:'merchant',name:'Купеческая счастливая',desc:'Повышенный шанс на 1 и 6. Золотистый оттенок.',cost:250,preview:'preview-merchant',weights:{1:2,2:1,3:1,4:1,5:1,6:2}}, wolf:{id:'wolf',name:'Волчья кость Ловчего',desc:'Повышенный шанс на 1 и 5. Тёмно-бордовый с янтарём.',cost:450,preview:'preview-wolf',weights:{1:2,2:1,3:1,4:1,5:2,6:1}} };
const SPECIAL_DICE_IDS=['odd','merchant','wolf'], MAX_SPECIAL_DICE=3, DICE_SET_SIZE=6;
function loadStringArray(key) { try{const p=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(p)?p.filter(v=>typeof v==='string'):[]}catch(e){return[]} }
let ownedDice=loadStringArray(STORAGE_KEYS.diceOwned).filter(id=>SPECIAL_DICE_IDS.includes(id));
let equippedDice=loadStringArray(STORAGE_KEYS.diceEquipped).filter(id=>ownedDice.includes(id)).slice(0,MAX_SPECIAL_DICE);
function saveDice(){localStorage.setItem(STORAGE_KEYS.diceOwned,JSON.stringify(ownedDice));localStorage.setItem(STORAGE_KEYS.diceEquipped,JSON.stringify(equippedDice));cloudSet(STORAGE_KEYS.diceOwned,JSON.stringify(ownedDice));cloudSet(STORAGE_KEYS.diceEquipped,JSON.stringify(equippedDice));}
function getPlayerDiceSet(){const s=equippedDice.slice(0,MAX_SPECIAL_DICE);while(s.length<DICE_SET_SIZE)s.push('ordinary');return s.slice(0,DICE_SET_SIZE);}
function renderDiceSetRow(){const row=document.getElementById('diceSetRow');if(!row)return;row.innerHTML='';getPlayerDiceSet().forEach(tid=>{const t=DICE_TYPES[tid]||DICE_TYPES.ordinary;const el=document.createElement('div');el.className='dice-preview '+t.preview;el.title=t.name;row.appendChild(el);});}
function renderDiceShop(){const list=document.getElementById('diceShopList');if(!list)return;const note=document.getElementById('diceShopNote');if(note)note.textContent='Особых костей в наборе: '+equippedDice.length+' / '+MAX_SPECIAL_DICE;renderDiceSetRow();list.innerHTML='';SPECIAL_DICE_IDS.forEach(id=>{const t=DICE_TYPES[id];const owned=ownedDice.includes(id);const equipped=equippedDice.includes(id);const item=document.createElement('div');item.className='shop-item'+(equipped?' equipped':(owned?' done':''));item.innerHTML='<div class="dice-preview '+t.preview+'"></div><div class="shop-info"><div class="shop-name">'+t.name+'</div><div class="shop-desc">'+t.desc+'</div><div class="shop-cost">'+(owned?(equipped?'<span class="tag-ok">✔ В наборе</span>':'<span class="tag-ok">✔ Куплено</span>'):t.cost+' 🪙')+'</div></div>';const btn=document.createElement('button');btn.type='button';if(!owned){btn.className='shop-btn buy';btn.textContent='Купить';btn.disabled=gold<t.cost;btn.addEventListener('click',()=>buyDice(id));}else if(equipped){btn.className='shop-btn';btn.textContent='Снять';btn.addEventListener('click',()=>equipDice(id,false));}else{btn.className='shop-btn equip';btn.textContent='Экипировать';btn.disabled=equippedDice.length>=MAX_SPECIAL_DICE;btn.addEventListener('click',()=>equipDice(id,true));}item.appendChild(btn);list.appendChild(item);});}
function buyDice(id){const t=DICE_TYPES[id];if(!t||ownedDice.includes(id))return;if(gold<t.cost){showToast('Нужно '+t.cost+' грошей, а в кошеле лишь '+gold+'.');triggerHaptic('notification','error');return;}soundManager.init();addGold(-t.cost);ownedDice.push(id);if(equippedDice.length<MAX_SPECIAL_DICE)equippedDice.push(id);saveDice();raiseAch('dice_collector', ownedDice.length);soundManager.playCoin();triggerHaptic('notification','success');showToast('Кость куплена: «'+t.name+'»!');renderDiceShop();}
function equipDice(id,equip){const t=DICE_TYPES[id];if(!t)return;if(equip){if(!ownedDice.includes(id)||equippedDice.includes(id))return;if(equippedDice.length>=MAX_SPECIAL_DICE){showToast('В наборе уже '+MAX_SPECIAL_DICE+' особых костей.');triggerHaptic('notification','warning');return;}equippedDice.push(id);showToast('«'+t.name+'» — в наборе.');}else{equippedDice=equippedDice.filter(item=>item!==id);showToast('«'+t.name+'» — из набора убрана.');}saveDice();soundManager.init();soundManager.playSelect();triggerHaptic('impact','light');renderDiceShop();}
/* --------------------------------------------------------------------------
   2j. Сезон 1: Промокоды (словарь подключается файлом promos.js → window.SEASON_PROMOS)
   Словарь больше не копируется в константу: currentPromoCodes() всегда читает
   актуальный window.SEASON_PROMOS, а refreshSeasonPromos(true) подгружает свежий
   promos.js?t=Date.now(). Поэтому новые коды из promos.js работают без
   перезапуска приложения и без правок game.js.
   -------------------------------------------------------------------------- */
const PROMO_SCRIPT_URL = 'promos.js';
const PROMO_SCRIPT_TIMEOUT = 6000;   // мс на попытку подгрузить свежий словарь кодов
let promoReloadSeq = 0;              // защита от гонок при нескольких перезагрузках подряд
function currentPromoCodes() {
  const dict = window.SEASON_PROMOS;
  return (dict && typeof dict === 'object') ? dict : {};
}
function normalizePromoCode(rawCode) { return String(rawCode == null ? '' : rawCode).trim().toUpperCase(); }
/* Свежий promos.js: динамический <script> с меткой времени, onload/onerror и таймаутом.
   forceReload=false — отдаём уже загруженный словарь, сеть не дёргаем.
   Сеть/файл недоступны — мягко откатываемся на прежний window.SEASON_PROMOS,
   интерфейс при этом не ломается. */
function refreshSeasonPromos(forceReload = false) {
  if (!forceReload) return Promise.resolve(currentPromoCodes());
  return new Promise((resolve) => {
    const seq = ++promoReloadSeq;
    const previous = currentPromoCodes();
    let settled = false, timer = null;
    const script = document.createElement('script');
    const finish = (loadedOk) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { script.remove(); } catch (e) {}
      // Откат только если это всё ещё последняя попытка и файл реально не загрузился
      if (!loadedOk && seq === promoReloadSeq && Object.keys(previous).length) window.SEASON_PROMOS = previous;
      resolve(currentPromoCodes());
    };
    script.src = PROMO_SCRIPT_URL + '?t=' + Date.now();
    script.async = true;
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    script.onabort = () => finish(false);
    timer = setTimeout(() => finish(false), PROMO_SCRIPT_TIMEOUT);
    try { document.head.appendChild(script); } catch (e) { finish(false); }
  });
}
const REFERRAL_LINK_BASE = 'https://t.me/tri_grosha_game_bot/PlayTriGrosha?startapp=ref_';
let redeemedPromos = loadStringArray(STORAGE_KEYS.promos);
function savePromoState() { const raw = JSON.stringify(redeemedPromos); try { localStorage.setItem(STORAGE_KEYS.promos, raw); } catch (e) {} cloudSet(STORAGE_KEYS.promos, raw); }
function makeReferralCode() {
  const uid = tg?.initDataUnsafe?.user?.id;
  if (uid) return 'TRG-' + String(uid).slice(-4).padStart(4, '0');
  return 'TRG-' + String(Math.floor(Math.random() * 9000) + 1000);
}
/* --- Друзья: личный код TRG-XXXX и список приглашённых (до 20 уникальных) --- */
const FRIEND_REWARD = 50;      // награда за каждого нового друга (1..20)
const NEWCOMER_BONUS = 50;     // бонус новичку, пришедшему по ссылке друга
const MAX_FRIENDS = 20;
const FRIEND_THRESHOLDS = [
  { count: 5, reward: 100 },
  { count: 10, reward: 500 },
  { count: 15, reward: 1000 },
  { count: 20, reward: 2000, achievement: 'company_soul' }
];
function loadFriendsState() {
  let s = null; try { s = JSON.parse(localStorage.getItem(STORAGE_KEYS.friends) || 'null'); } catch (e) { s = null; }
  if (!s || typeof s !== 'object') {
    // Переносим старую схему рефералов Сезона 1 (один введённый код друга)
    let legacy = null; try { legacy = JSON.parse(localStorage.getItem(STORAGE_KEYS.referral) || 'null'); } catch (e) { legacy = null; }
    s = (legacy && typeof legacy === 'object')
      ? { code: legacy.code, friends: (legacy.friendUsed && typeof legacy.friendCode === 'string' && /^TRG-\d{4}$/.test(legacy.friendCode)) ? [legacy.friendCode] : [] }
      : {};
  }
  if (typeof s.code !== 'string' || !/^TRG-\d{4}$/.test(s.code)) s.code = makeReferralCode();
  s.friends = Array.isArray(s.friends)
    ? s.friends.filter(c => typeof c === 'string' && /^TRG-\d{4}$/.test(c) && c !== s.code)
        .filter((c, i, arr) => arr.indexOf(c) === i).slice(0, MAX_FRIENDS)
    : [];
  s.friendsCount = Number.isFinite(s.friendsCount) ? Math.max(0, Math.min(Math.floor(s.friendsCount), MAX_FRIENDS)) : 0;
  s.inviteBonus = Boolean(s.inviteBonus);
  s.redeemUsed = Boolean(s.redeemUsed);
  const claimed = Array.isArray(s.thresholdClaimed) ? s.thresholdClaimed : [];
  const countedFriends = Math.max(s.friends.length, s.friendsCount);
  s.thresholdClaimed = FRIEND_THRESHOLDS.filter(t => claimed.includes(t.count) || countedFriends >= t.count).map(t => t.count);
  return s;
}
let friendsState = loadFriendsState();
function saveFriendsState() { const raw = JSON.stringify(friendsState); try { localStorage.setItem(STORAGE_KEYS.friends, raw); } catch (e) {} cloudSet(STORAGE_KEYS.friends, raw); }
function referralLink() { return REFERRAL_LINK_BASE + friendsState.code; }
saveFriendsState();
/* Уже активированные игроком коды: локальный список (localStorage) + Telegram CloudStorage.
   Один и тот же код нельзя активировать дважды даже на другом устройстве;
   если облако не отвечает — мягко проверяем по локальному списку. */
function usedPromoCodes() {
  return new Promise((resolve) => {
    const local = (Array.isArray(redeemedPromos) ? redeemedPromos : []);
    let settled = false, timer = null;
    const finish = (raw) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      let cloud = [];
      try { const parsed = JSON.parse(raw || '[]'); if (Array.isArray(parsed)) cloud = parsed; } catch (e) { cloud = []; }
      const merged = local.concat(cloud)
        .map(normalizePromoCode)
        .filter(c => c.length > 0)
        .filter((c, i, arr) => arr.indexOf(c) === i);
      // Коды, известные только облаку, запоминаем локально — защита сработает и без сети
      let changed = false;
      merged.forEach((c) => {
        if (!local.some(x => normalizePromoCode(x) === c)) { redeemedPromos.push(c); changed = true; }
      });
      if (changed) savePromoState();
      resolve(merged);
    };
    if (!cloudStorage) { finish('[]'); return; }
    timer = setTimeout(() => finish(JSON.stringify(redeemedPromos)), 4000);
    cloudGetItems([STORAGE_KEYS.promos], (data) => finish(data ? data[STORAGE_KEYS.promos] : '[]'));
  });
}
/* Проверка кода: нормализация → свежий словарь window.SEASON_PROMOS → защита от повторной активации */
async function redeemPromo(rawCode, forceReload = false) {
  const code = normalizePromoCode(rawCode);
  if (!code) { showToast('Введите промокод.'); return false; }
  // Перед проверкой кода подтягиваем свежий promos.js (forceReload=true → сеть)
  const promos = await refreshSeasonPromos(forceReload);
  const reward = Number(promos[code]);
  if (!Object.prototype.hasOwnProperty.call(promos, code) || !Number.isFinite(reward) || reward <= 0) {
    showToast('Такого промокода Сезона 1 нет.'); triggerHaptic('notification', 'error'); return false;
  }
  const used = await usedPromoCodes();
  const localUsed = (Array.isArray(redeemedPromos) ? redeemedPromos : []).map(normalizePromoCode);
  if (used.includes(code) || localUsed.includes(code)) {
    showToast('Промокод «' + code + '» уже использован.'); triggerHaptic('notification', 'warning'); return false;
  }
  redeemedPromos.push(code); savePromoState();
  addGold(reward, true);
  triggerHaptic('notification', 'success');
  showToast('Промокод «' + code + '» принят: +' + reward + ' грошей!');
  renderPromoModal(); updateBegButton();
  return true;
}
/* Синхронизация рефералов с API-сервером (до подключения Worker'а — офлайн-заглушка) */
let lastRefSyncAt = 0;
function syncReferralsWithServer(force = false) {
  if (!isRefApiReady()) return;
  // Защита от лагов и спама: без force сетевой запрос идёт не чаще одного раза в 10 секунд
  if (!force && Date.now() - lastRefSyncAt < 10000) return;
  lastRefSyncAt = Date.now();
  let initData = '', startParam = '';
  try { initData = window.Telegram?.WebApp?.initData || ''; } catch (e) { initData = ''; }
  try { startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param || ''; } catch (e) { startParam = ''; }
  try {
    fetch(REF_API_URL + '/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, startParam })
    })
      .then(res => {
        if (!res || !res.ok) { console.warn('Ref sync error:', res); return null; }
        return res.json();
      })
      .then(data => {
        if (!data) return;
        // Ошибку сервера логируем (например, проблема с BOT_TOKEN), но игру не ломаем
        if (data.ok === false) { console.warn('Ref sync error:', data); return; }
        if (data.ok) applyServerReferralData(data);
      })
      .catch(() => {});
  } catch (e) { /* сеть недоступна — попробуем при следующем запуске */ }
}
function applyServerReferralData(data) {
  let changed = false;
  if (typeof data.myCode === 'string' && /^TRG-\d{4}$/.test(data.myCode) && data.myCode !== friendsState.code) {
    friendsState.code = data.myCode; changed = true;
  }
  // Сервер — источник истины: счётчик и массив друзей приводим напрямую по ответу сервера
  const count = Math.max(0, Math.min(Math.floor(Number(data.friendsCount) || 0), MAX_FRIENDS));
  if (count !== friendsState.friendsCount) { friendsState.friendsCount = count; changed = true; }
  if (Array.isArray(data.friends)) {
    const codes = data.friends.filter(c => typeof c === 'string' && /^TRG-\d{4}$/.test(c))
      .filter((c, i, arr) => arr.indexOf(c) === i).slice(0, MAX_FRIENDS);
    if (codes.join(',') !== friendsState.friends.join(',')) { friendsState.friends = codes; changed = true; }
  }
  // Сервер вернул 0 друзей — полностью очищаем старые локальные записи до-серверного периода
  if (count === 0 && friendsState.friends.length) { friendsState.friends = []; changed = true; }
  if (Array.isArray(data.claimedMilestones)) {
    data.claimedMilestones.forEach(m => {
      const n = parseInt(m, 10);
      if (Number.isFinite(n) && !friendsState.thresholdClaimed.includes(n)) { friendsState.thresholdClaimed.push(n); changed = true; }
    });
  }
  if (data.redeemUsed === true && !friendsState.redeemUsed) { friendsState.redeemUsed = true; changed = true; }
  if (changed) saveFriendsState();
  // 1) Награда за друзей: 50 за каждого + разовые пороги — доначисляем только разницу
  const dueTotal = friendsRewardTotal(count);
  const paidTotal = friendsPaidTotal();
  if (dueTotal > paidTotal) {
    const diff = dueTotal - paidTotal;
    saveFriendsPaidTotal(dueTotal);
    addGold(diff, true);
    showToast('🤝 По вашей ссылке присоединились друзья! Начислено: +' + diff + ' грошей');
  }
  // 2) Бонус новичка, пришедшему по ссылке друга
  if (data.welcomeBonusGranted === true) grantWelcomeBonus();
  // 3) 20 друзей по ссылке открывают «Душу компании»
  if (count >= MAX_FRIENDS) unlockAch('company_soul');
  renderFriendsModal();
  renderTavern();
}
/* --- Друзья: коды принимает ТОЛЬКО сервер — локальная накрутка полностью убрана --- */
function friendsPaidTotal() {
  const v = parseInt(localStorage.getItem(STORAGE_KEYS.refPaidTotal) || '0', 10);
  return (Number.isFinite(v) && v > 0) ? v : 0;
}
function saveFriendsPaidTotal(total) {
  try { localStorage.setItem(STORAGE_KEYS.refPaidTotal, String(total)); } catch (e) {}
  cloudSet(STORAGE_KEYS.refPaidTotal, String(total));
}
function friendCount() { return Math.max(friendsState.friends.length, friendsState.friendsCount || 0); }
/* Общая положенная награда за N друзей: 50 за каждого + разовые пороговые бонусы */
function friendsRewardTotal(count) {
  const safe = Math.max(0, Math.min(parseInt(count, 10) || 0, MAX_FRIENDS));
  let total = safe * FRIEND_REWARD;
  FRIEND_THRESHOLDS.forEach(t => { if (safe >= t.count) total += t.reward; });
  return total;
}
function isWelcomeBonusPaid() {
  if (friendsState.inviteBonus) return true;
  try { return localStorage.getItem(STORAGE_KEYS.welcomePaid) === '1'; } catch (e) { return false; }
}
function markWelcomeBonusPaid() {
  friendsState.inviteBonus = true; saveFriendsState();
  try { localStorage.setItem(STORAGE_KEYS.welcomePaid, '1'); } catch (e) {}
  cloudSet(STORAGE_KEYS.welcomePaid, '1');
}
/* +50 новичку, пришедшему по ссылке друга (начисляется строго один раз) */
function grantWelcomeBonus() {
  if (isWelcomeBonusPaid()) return false;
  markWelcomeBonusPaid();
  addGold(NEWCOMER_BONUS, true);
  triggerHaptic('notification', 'success');
  showToast('🎉 Бонус новичка за приглашение по ссылке: +' + NEWCOMER_BONUS + ' грошей!');
  renderFriendsModal();
  return true;
}
/* Стартовая ссылка вида ref_TRG-XXXX: +50 новичку (один раз, флаг trigrosha_s1_welcome_paid) */
function activateStartParamReferral() {
  let param = ''; try { param = tg?.initDataUnsafe?.start_param || ''; } catch (e) { param = ''; }
  const m = String(param).match(/^ref_(TRG-\d{4})$/i);
  if (!m) return false;
  const code = m[1].toUpperCase();
  if (code === friendsState.code) return false;
  return grantWelcomeBonus();
}
/* Ручной ввод кода друга: отправляем на сервер, локального начисления больше нет */
function submitFriendCode() {
  const input = document.getElementById('refFriendInput');
  if (!input) return false;
  const code = String(input.value || '').trim().toUpperCase();
  if (!code) { showToast('Введите код друга.'); return false; }
  if (!/^TRG-\d{4}$/.test(code)) { showToast('Код друга должен быть вида TRG-XXXX.'); triggerHaptic('notification', 'error'); return false; }
  if (code === friendsState.code) { showToast('Свой код вводить нельзя.'); triggerHaptic('notification', 'error'); return false; }
  if (friendsState.redeemUsed) { showToast('Код друга уже активирован — он действует лишь однажды.'); triggerHaptic('notification', 'warning'); return false; }
  if (!isRefApiReady()) {
    triggerHaptic('notification', 'warning');
    showToast('Ввод кодов друзей временно на техобслуживании — приглашайте друзей по своей ссылке!');
    return false;
  }
  let initData = ''; try { initData = window.Telegram?.WebApp?.initData || ''; } catch (e) { initData = ''; }
  try {
    fetch(REF_API_URL + '/api/redeem-ref', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, refCode: code })
    })
      .then(res => (res && res.ok ? res.json() : null))
      .then(data => {
        if (data && data.ok) {
          friendsState.redeemUsed = true; saveFriendsState();
          input.value = ''; renderFriendsModal();
          triggerHaptic('notification', 'success');
          showToast('Код друга «' + code + '» принят сервером!');
          syncReferralsWithServer();
        } else {
          triggerHaptic('notification', 'error');
          // Точный текст ошибки от сервера (если он есть), иначе — общая заглушка
          showToast((data && data.error) ? String(data.error) : 'Сервер не принял этот код друга.');
        }
      })
      .catch(() => { triggerHaptic('notification', 'error'); showToast('Сервер недоступен — попробуйте позже.'); });
  } catch (e) { showToast('Сервер недоступен — попробуйте позже.'); }
  return true;
}
function copyReferralLink() {
  const link = referralLink();
  const done = () => { showToast('Ссылка скопирована — приглашайте друзей!'); triggerHaptic('notification', 'success'); };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea'); ta.value = link; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); done();
    } catch (e) { showToast('Скопируйте ссылку вручную: ' + link); }
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done).catch(fallback);
    else fallback();
  } catch (e) { fallback(); }
}
function renderPromoCounters() {
  const counters = document.getElementById('promoCounters');
  if (!counters) return;
  const total = Object.keys(currentPromoCodes()).length;
  counters.textContent = (redeemedPromos.length
    ? 'Активировано кодов Сезона 1: ' + redeemedPromos.length
    : 'Пока не активировано ни одного кода.')
    + (total ? ' · Доступно кодов: ' + total : '');
}
function renderPromoModal() {
  renderPromoCounters();
  const input = document.getElementById('promoInput'); if (input) input.value = '';
}
function renderFriendsModal() {
  const codeEl = document.getElementById('refCodeValue'); if (codeEl) codeEl.textContent = friendsState.code;
  const count = friendCount();
  const label = document.getElementById('friendProgressLabel');
  if (label) label.textContent = count + ' / ' + MAX_FRIENDS;
  const fill = document.getElementById('friendProgressFill');
  if (fill) fill.style.width = Math.round((count / MAX_FRIENDS) * 100) + '%';
  const thresholds = document.getElementById('friendThresholdList');
  if (thresholds) {
    thresholds.innerHTML = '';
    FRIEND_THRESHOLDS.forEach(t => {
      const done = count >= t.count;
      const item = document.createElement('div');
      item.className = 'threshold-item' + (done ? ' done' : '') + (t.achievement ? ' with-ach' : '');
      item.innerHTML = '<span class="threshold-count">' + t.count + ' друзей</span>'
        + '<span class="threshold-reward">' + (done ? '✔ ' : '') + '+' + t.reward + ' 🪙</span>'
        + (t.achievement ? '<span class="threshold-ach">🏆 ачивка «Душа компании»</span>' : '');
      thresholds.appendChild(item);
    });
  }
  const inviteNote = document.getElementById('friendInviteNote');
  if (inviteNote) inviteNote.textContent = isWelcomeBonusPaid()
    ? '🎉 Бонус новичка за приглашение по ссылке уже получен (+' + NEWCOMER_BONUS + ' 🪙).'
    : 'Пришли по ссылке друга? Бонус новичка +' + NEWCOMER_BONUS + ' 🪙 придёт автоматически после перехода по ссылке.';
  const note = document.getElementById('refNote');
  if (note) note.textContent = count >= MAX_FRIENDS
    ? 'Все ' + MAX_FRIENDS + ' друзей приглашены — «Душа компании» ваша!'
    : 'Друзья засчитываются автоматически после перехода по вашей ссылке: +' + FRIEND_REWARD
      + ' 🪙 за каждого · приглашено ' + count + ' из ' + MAX_FRIENDS + '. Свой код вводить нельзя.';
  const redeemNote = document.getElementById('refRedeemNote');
  if (redeemNote) redeemNote.textContent = friendsState.redeemUsed
    ? '✅ Код друга уже активирован — повторно ввести его нельзя.'
    : (isRefApiReady()
      ? 'Код друга принимает сервер и только один раз.'
      : 'Ввод кодов друзей временно на техобслуживании — приглашайте друзей по своей ссылке!');
  const codeList = document.getElementById('friendCodeList');
  if (codeList) {
    codeList.innerHTML = '';
    if (!count) {
      const empty = document.createElement('span');
      empty.className = 'friend-empty';
      empty.textContent = 'Список друзей подтянется с сервера после синхронизации.';
      codeList.appendChild(empty);
    } else {
      // Компактно: выводим только последние 5 записей, чтобы карточка не растягивалась по высоте
      const total = friendsState.friends.length;
      friendsState.friends.slice(-5).forEach(c => {
        const chip = document.createElement('span');
        chip.className = 'friend-chip';
        chip.textContent = c;
        codeList.appendChild(chip);
      });
      if (total > 5) {
        const more = document.createElement('span');
        more.className = 'friend-chip friend-chip-more';
        more.textContent = 'и ещё +' + (total - 5) + '...';
        codeList.appendChild(more);
      }
    }
  }
  const full = count >= MAX_FRIENDS;
  const locked = full || friendsState.redeemUsed;
  const input = document.getElementById('refFriendInput'), btn = document.getElementById('refFriendBtn');
  if (input) {
    input.disabled = locked;
    input.placeholder = friendsState.redeemUsed ? '✅ Код друга уже активирован' : (full ? 'Все ' + MAX_FRIENDS + ' друзей приглашены' : 'Код друга (TRG-XXXX)');
    if (locked) input.value = '';
  }
  if (btn) { btn.disabled = locked; btn.textContent = locked ? '✔' : 'Ввести'; }
}
/* --------------------------------------------------------------------------
   2k. Сезон 1: Достижения — 20 наград + 1 секретная (localStorage + CloudStorage)
   -------------------------------------------------------------------------- */
const ACHIEVEMENTS = [
  { id:'first_win', icon:'🩸', name:'Первая кровь', desc:'Одержи 1 победу за столом', goal:1 },
  { id:'regular', icon:'🍺', name:'Завсегдатай корчмы', desc:'Сыграй 10 партий', goal:10 },
  { id:'county_thunder', icon:'⚡', name:'Гроза уезда', desc:'Одержи 25 побед', goal:25 },
  { id:'mr_luck', icon:'🍀', name:'Мистер Удача', desc:'Поймай Зонк с первого броска в ходу', goal:1 },
  { id:'fireproof', icon:'🛡️', name:'Несгораемый', desc:'Забери в банк 1000 или более очков за один ход', goal:1 },
  { id:'mad_risk', icon:'🃏', name:'Безумный риск', desc:'Перебрось 1 оставшийся кубик и не поймай Зонк', goal:1 },
  { id:'hot_hand', icon:'🔥', name:'Горячая рука', desc:'Активируй «Горячие кости» 5 раз', goal:5 },
  { id:'uncle_catala', icon:'🎩', name:'Дядя Катала', desc:'Собери полный стрит 1-2-3-4-5-6', goal:1 },
  { id:'golden_hand', icon:'👑', name:'Золотая ручка', desc:'Собери 10 полных стритов 1-2-3-4-5-6', goal:10 },
  { id:'small_tactician', icon:'📐', name:'Малый тактик', desc:'Собери 15 малых стритов (1-5 или 2-6)', goal:15 },
  { id:'pair_dance', icon:'💃', name:'Парный танец', desc:'Собери «3 пары» 5 раз', goal:5 },
  { id:'triple_strike', icon:'🎯', name:'Тройной удар', desc:'Выбей комбинацию из 4 и более одинаковых костей', goal:1 },
  { id:'beat_sivka', icon:'🐴', name:'Гроза конюшни', desc:'Обыграй Конюха Сивку 3 раза', goal:3 },
  { id:'beat_ignat', icon:'🍲', name:'Сытый кузнец', desc:'Обыграй Голодного Игната 3 раза', goal:3 },
  { id:'beat_yashka', icon:'🪕', name:'Переиграл балагура', desc:'Обыграй Гусельника Яшку 3 раза', goal:3 },
  { id:'beat_lovchiy', icon:'🏹', name:'Охотник на охотника', desc:'Обыграй Седого Ловчего 3 раза', goal:3 },
  { id:'dice_collector', icon:'🎲', name:'Коллекционер костей', desc:'Купи все 3 особые кости в Лавке', goal:3 },
  { id:'inn_master', icon:'🏠', name:'Хозяин двора', desc:'Заверши обустройство двора (4/4)', goal:4 },
  { id:'rich_purse', icon:'💰', name:'Звонкий кошель', desc:'Накопи 1000 грошей разом', goal:1000 },
  { id:'company_soul', icon:'🤝', name:'Душа компании', desc:'Пригласи 20 друзей в таверну', goal:20 }
];
/* Секретная 21-я ачивка: открывается автоматически, когда собраны все 20 */
const SECRET_ACHIEVEMENT = { id:'avid_zonker', icon:'💀', name:'Заядлый зонкер', desc:'Секретное достижение', goal:1 };
const SECRET_ACHIEVEMENT_REWARD = 3000;
const OPPONENT_ACHIEVEMENTS = { sivka:'beat_sivka', ignat:'beat_ignat', yashka:'beat_yashka', lovchiy:'beat_lovchiy' };
function loadAchState() {
  let s = null; try { s = JSON.parse(localStorage.getItem(STORAGE_KEYS.achievements) || 'null'); } catch (e) { s = null; }
  if (!s || typeof s !== 'object') s = {};
  if (!s.progress || typeof s.progress !== 'object') s.progress = {};
  if (!s.unlocked || typeof s.unlocked !== 'object') s.unlocked = {};
  ACHIEVEMENTS.concat([SECRET_ACHIEVEMENT]).forEach(a => {
    if (!Number.isFinite(s.progress[a.id])) s.progress[a.id] = 0;
    s.unlocked[a.id] = Boolean(s.unlocked[a.id]) || s.progress[a.id] >= a.goal;
  });
  return s;
}
let achState = loadAchState();
let achToastMuted = false;
function saveAchState() { const raw = JSON.stringify(achState); try { localStorage.setItem(STORAGE_KEYS.achievements, raw); } catch (e) {} cloudSet(STORAGE_KEYS.achievements, raw); }
function achProgress(id) { return achState.progress[id] || 0; }
function isAchUnlocked(id) { return Boolean(achState.unlocked[id]); }
function achUnlockedCount() { return ACHIEVEMENTS.filter(a => isAchUnlocked(a.id)).length; }
function achAllUnlocked() { return ACHIEVEMENTS.every(a => isAchUnlocked(a.id)); }
function achToast(a) { if (!achToastMuted) showToast('🏆 Достижение: «' + a.name + '»!'); }
function refreshAchUI() { renderAchBadge(); if (document.getElementById('achievementsModal').classList.contains('active')) renderAchievements(); }
function unlockAch(id, silent) {
  const a = (id === SECRET_ACHIEVEMENT.id) ? SECRET_ACHIEVEMENT : ACHIEVEMENTS.find(x => x.id === id);
  if (!a || isAchUnlocked(id)) return false;
  achState.progress[id] = a.goal; achState.unlocked[id] = true; saveAchState();
  if (!silent) { achToast(a); triggerHaptic('notification', 'success'); }
  if (id !== SECRET_ACHIEVEMENT.id) checkSecretAchievement();
  refreshAchUI();
  return true;
}
function bumpAch(id, amount = 1) {
  const a = ACHIEVEMENTS.find(x => x.id === id);
  if (!a || isAchUnlocked(id)) return;
  const current = achProgress(id), next = Math.min(current + amount, a.goal);
  if (next <= current) return;
  achState.progress[id] = next;
  if (next >= a.goal) unlockAch(id); else { saveAchState(); refreshAchUI(); }
}
function raiseAch(id, value) {
  const a = ACHIEVEMENTS.find(x => x.id === id);
  if (!a || isAchUnlocked(id) || value <= achProgress(id)) return;
  const next = Math.min(value, a.goal);
  achState.progress[id] = next;
  if (next >= a.goal) unlockAch(id); else { saveAchState(); refreshAchUI(); }
}
/* Секретная ачивка: все 20 собраны → «Заядлый зонкер» и +3000 грошей со звоном монет */
function checkSecretAchievement() {
  if (isAchUnlocked(SECRET_ACHIEVEMENT.id) || !achAllUnlocked()) return;
  achState.progress[SECRET_ACHIEVEMENT.id] = 1; achState.unlocked[SECRET_ACHIEVEMENT.id] = true; saveAchState();
  addGold(SECRET_ACHIEVEMENT_REWARD, true);
  showToast('💀 Секретное достижение «' + SECRET_ACHIEVEMENT.name + '»: +' + SECRET_ACHIEVEMENT_REWARD + ' грошей!');
  triggerHaptic('notification', 'success');
  refreshAchUI();
}
function comboKindsForAchievements(values) {
  const counts = [0,0,0,0,0,0,0]; values.forEach(v => counts[v]++);
  const kinds = [];
  const fullStraight = counts[1]===1&&counts[2]===1&&counts[3]===1&&counts[4]===1&&counts[5]===1&&counts[6]===1;
  const lowStraight = counts[1]>=1&&counts[2]>=1&&counts[3]>=1&&counts[4]>=1&&counts[5]>=1;
  const highStraight = counts[2]>=1&&counts[3]>=1&&counts[4]>=1&&counts[5]>=1&&counts[6]>=1;
  if (fullStraight) kinds.push('full_straight');
  else if (lowStraight || highStraight) kinds.push('small_straight');
  if (values.length === 6 && counts.filter(c => c === 2).length === 3) kinds.push('three_pairs');
  if (counts.some(c => c >= 4)) kinds.push('four_kind');
  return kinds;
}
function registerPlayerCombo(values) {
  const kinds = comboKindsForAchievements(values);
  if (kinds.includes('full_straight')) { bumpAch('uncle_catala', 1); bumpAch('golden_hand', 1); }
  if (kinds.includes('small_straight')) bumpAch('small_tactician', 1);
  if (kinds.includes('three_pairs')) bumpAch('pair_dance', 1);
  if (kinds.includes('four_kind')) unlockAch('triple_strike');
}
/* Пересчёт «по состоянию» — для побед, грошей, лавки, обустройства и друзей */
function checkPersistentAchievements(muteToast) {
  achToastMuted = Boolean(muteToast);
  raiseAch('first_win', winsCount);
  raiseAch('county_thunder', winsCount);
  raiseAch('rich_purse', gold);
  raiseAch('dice_collector', ownedDice.length);
  raiseAch('inn_master', purchasedUpgrades.length);
  raiseAch('company_soul', friendCount());
  achToastMuted = false;
  refreshAchUI();
}
function achItemMarkup(a, secret) {
  const unlocked = isAchUnlocked(a.id), hidden = secret && !unlocked;
  const item = document.createElement('div');
  item.className = 'ach-item ' + (unlocked ? 'unlocked' : 'locked') + (secret ? ' secret' : '');
  const name = hidden ? '??? — Секретное достижение' : a.name;
  const desc = hidden ? 'Откройте все ' + ACHIEVEMENTS.length + ' достижений таверны — и узнаете.' : a.desc;
  const state = unlocked
    ? (secret ? '💀 +' + SECRET_ACHIEVEMENT_REWARD + ' 🪙' : '✔ Открыто')
    : (secret ? 'Заперто' : (a.goal > 1 ? Math.min(achProgress(a.id), a.goal) + ' / ' + a.goal : 'Закрыто'));
  item.innerHTML = '<span class="ach-icon">' + (hidden ? '❓' : a.icon) + '</span><div class="ach-body"><span class="ach-name">' + name + '</span><span class="ach-desc">' + desc + '</span></div><span class="ach-state">' + state + '</span>';
  return item;
}
function renderAchBadge() {
  const btn = document.getElementById('achievementsBtn');
  if (btn) btn.textContent = '🏆 Достижения (' + achUnlockedCount() + '/' + (ACHIEVEMENTS.length + 1) + ')';
}
function renderAchievements() {
  const list = document.getElementById('achievementList'); if (!list) return;
  const counter = document.getElementById('achCounter');
  if (counter) counter.textContent = 'Открыто ' + achUnlockedCount() + ' / ' + ACHIEVEMENTS.length + (isAchUnlocked(SECRET_ACHIEVEMENT.id) ? ' · секретная открыта!' : '');
  list.innerHTML = '';
  ACHIEVEMENTS.forEach(a => list.appendChild(achItemMarkup(a, false)));
  list.appendChild(achItemMarkup(SECRET_ACHIEVEMENT, true));
}

/* --- Telegram CloudStorage: фоновый бэкап и восстановление прогресса --- */
function flushCloudProgress() {
  if (!cloudStorage || !cloudReady) return;
  cloudSet(STORAGE_KEYS.gold, gold);
  cloudSet(STORAGE_KEYS.wins, winsCount);
  cloudSet(STORAGE_KEYS.upgrades, JSON.stringify(purchasedUpgrades));
  cloudSet(STORAGE_KEYS.diceOwned, JSON.stringify(ownedDice));
  cloudSet(STORAGE_KEYS.diceEquipped, JSON.stringify(equippedDice));
  cloudSet(STORAGE_KEYS.quests, JSON.stringify(questState));
  cloudSet(STORAGE_KEYS.promos, JSON.stringify(redeemedPromos));
  cloudSet(STORAGE_KEYS.friends, JSON.stringify(friendsState));
  cloudSet(STORAGE_KEYS.refPaidTotal, String(friendsPaidTotal()));
  cloudSet(STORAGE_KEYS.welcomePaid, isWelcomeBonusPaid() ? '1' : '0');
  cloudSet(STORAGE_KEYS.achievements, JSON.stringify(achState));
}
function syncCloudProgress() {
  if (!cloudStorage) return;
  setTimeout(() => { cloudReady = true; }, 8000);
  cloudGetItems(CLOUD_SYNC_KEYS.concat(EPOCH_STORAGE_KEY), (data) => {
    // Сброс по версии сезона: облако со старой эпохой игнорируем и
    // перезаписываем его чистым стартовым состоянием.
    if (data[EPOCH_STORAGE_KEY] !== SAVE_EPOCH) {
      cloudReady = true;
      cloudSet(EPOCH_STORAGE_KEY, SAVE_EPOCH);
      flushCloudProgress();
      return;
    }
    let restored = false;
    CLOUD_SYNC_KEYS.forEach(k => {
      const val = data[k];
      if (typeof val !== 'string' || val === '') return;
      if (localKeysAtBoot.has(k)) return; // локальные данные приоритетнее
      try { localStorage.setItem(k, val); restored = true; } catch (e) {}
    });
    cloudReady = true;
    if (!restored) { flushCloudProgress(); return; }
    gold = parseInt(localStorage.getItem(STORAGE_KEYS.gold), 10); if (!Number.isFinite(gold)) gold = START_GOLD;
    winsCount = parseInt(localStorage.getItem(STORAGE_KEYS.wins) || '0', 10) || 0;
    purchasedUpgrades = loadUpgrades();
    ownedDice = loadStringArray(STORAGE_KEYS.diceOwned).filter(id => SPECIAL_DICE_IDS.includes(id));
    equippedDice = loadStringArray(STORAGE_KEYS.diceEquipped).filter(id => ownedDice.includes(id)).slice(0, MAX_SPECIAL_DICE);
    questState = loadQuestState();
    redeemedPromos = loadStringArray(STORAGE_KEYS.promos);
    friendsState = loadFriendsState();
    achState = loadAchState();
    applyUpgrades(); updateHeader(); renderTable(); updateSpeedToggleUI(); renderQuestBadge();
    renderTavern(); renderFriendsModal(); renderAchievements(); checkPersistentAchievements(true);
  });
}

/* --------------------------------------------------------------------------
   3. Combination Scoring Engine (FIX #2: 4+pair priority + small straights)
   -------------------------------------------------------------------------- */
function evaluateDiceSelection(values) {
  if (!values || values.length === 0) return { score: 0, valid: true, comboName: '' };
  const counts = [0,0,0,0,0,0,0]; values.forEach(v => counts[v]++);
  let score = 0, usedCount = 0, comboName = '';
  if (values.length === 6) {
    if (counts[1]===1&&counts[2]===1&&counts[3]===1&&counts[4]===1&&counts[5]===1&&counts[6]===1) return { score:1500, valid:true, comboName:'Стрит (1-6) [+1500]' };
    if (counts[1]>=1&&counts[2]>=1&&counts[3]>=1&&counts[4]>=1&&counts[5]>=1) { score=500; usedCount=5; counts[1]--;counts[2]--;counts[3]--;counts[4]--;counts[5]--; comboName='Малый стрит 1-5 [+500]'; let extraOk=false; if(counts[1]>0){score+=100;usedCount++;counts[1]--;comboName+=' +1';extraOk=true;}else if(counts[5]>0){score+=50;usedCount++;counts[5]--;comboName+=' +5';extraOk=true;} return {score:(extraOk?score:0),valid:extraOk,comboName:(extraOk?comboName.trim():'Малый стрит 1-5 [+500] (6-я кость должна быть 1 или 5)')}; }
    if (counts[2]>=1&&counts[3]>=1&&counts[4]>=1&&counts[5]>=1&&counts[6]>=1) { score=750; usedCount=5; counts[2]--;counts[3]--;counts[4]--;counts[5]--;counts[6]--; comboName='Малый стрит 2-6 [+750]'; let extraOk=false; if(counts[5]>0){score+=50;usedCount++;counts[5]--;comboName+=' +5';extraOk=true;}else if(counts[1]>0){score+=100;usedCount++;counts[1]--;comboName+=' +1';extraOk=true;} return {score:(extraOk?score:0),valid:extraOk,comboName:(extraOk?comboName.trim():'Малый стрит 2-6 [+750] (6-я кость должна быть 1 или 5)')}; }
    if (counts.filter(c => c === 2).length === 3) return { score:750, valid:true, comboName:'3 пары [+750]' };
  }
  // Малый стрит можно забрать и пятью костями — шестая кость при этом не берётся
  if (values.length === 5) {
    if (counts[1]===1&&counts[2]===1&&counts[3]===1&&counts[4]===1&&counts[5]===1) return { score:500, valid:true, comboName:'Малый стрит 1-5 [+500]' };
    if (counts[2]===1&&counts[3]===1&&counts[4]===1&&counts[5]===1&&counts[6]===1) return { score:750, valid:true, comboName:'Малый стрит 2-6 [+750]' };
  }
  const multiKindScore = (val, count) => {
    const base = (val === 1) ? 1000 : val * 100;
    const factor = count >= 6 ? 8 : (count === 5 ? 4 : (count === 4 ? 2 : 1));
    return base * factor;
  };
  for (let val=1; val<=6; val++) {
    if (counts[val]>=6) { const pts=multiKindScore(val,6); score+=pts; usedCount+=6; counts[val]-=6; comboName+=' 6×'+val+' [+'+pts+']'; }
    else if (counts[val]>=5) { const pts=multiKindScore(val,5); score+=pts; usedCount+=5; counts[val]-=5; comboName+=' 5×'+val+' [+'+pts+']'; }
    else if (counts[val]>=4) { const pts=multiKindScore(val,4); score+=pts; usedCount+=4; counts[val]-=4; comboName+=' 4×'+val+' [+'+pts+']'; }
    else if (counts[val]>=3) { const pts=multiKindScore(val,3); score+=pts; usedCount+=3; counts[val]-=3; comboName+=' 3×'+val+' [+'+pts+']'; }
  }
  if (counts[1]>0) { score+=counts[1]*100; usedCount+=counts[1]; comboName+=' Единица(x'+counts[1]+')'; counts[1]=0; }
  if (counts[5]>0) { score+=counts[5]*50; usedCount+=counts[5]; comboName+=' Пятерка(x'+counts[5]+')'; counts[5]=0; }
  const valid = (usedCount===values.length);
  return { score:valid?score:0, valid, comboName:valid?comboName.trim():'Неверный выбор (только призовые кости!)' };
}

function hasScoringDice(rolledValues) {
  if (!rolledValues||rolledValues.length===0) return false;
  const counts=[0,0,0,0,0,0,0]; rolledValues.forEach(v=>counts[v]++);
  if(counts[1]>0||counts[5]>0) return true;
  if(counts.some(c=>c>=3)) return true;
  if(rolledValues.length===6) {
    if(counts[1]>=1&&counts[2]>=1&&counts[3]>=1&&counts[4]>=1&&counts[5]>=1&&counts[6]>=1) return true;
    if(counts[1]>=1&&counts[2]>=1&&counts[3]>=1&&counts[4]>=1&&counts[5]>=1) return true;
    if(counts[2]>=1&&counts[3]>=1&&counts[4]>=1&&counts[5]>=1&&counts[6]>=1) return true;
    if(counts.filter(c=>c===2).length===3) return true;
  }
  return false;
}
/* --------------------------------------------------------------------------
   2d. Daily Quests
   -------------------------------------------------------------------------- */
const QUESTS = [
  { id:'plays', name:'Разогрев в корчме', desc:'Сыграй 3 партии за столом', goal:3, reward:30 },
  { id:'hand', name:'Удачная рука', desc:'Набери 600 или более очков за один ход', goal:600, reward:50 },
  { id:'wins', name:'Гроза таверны', desc:'Одержи 2 победы над любыми соперниками', goal:2, reward:80 }
];
function todayKey(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function loadQuestState(){let s=null;try{s=JSON.parse(localStorage.getItem(STORAGE_KEYS.quests)||'null')}catch(e){s=null}const today=todayKey();if(!s||typeof s!=='object'||s.date!==today){s={date:today,progress:{},claimed:{}}}s.progress=s.progress||{};s.claimed=s.claimed||{};QUESTS.forEach(q=>{if(typeof s.progress[q.id]!=='number')s.progress[q.id]=0;if(typeof s.claimed[q.id]!=='boolean')s.claimed[q.id]=false});return s;}
function saveQuestState(){const raw=JSON.stringify(questState);localStorage.setItem(STORAGE_KEYS.quests,raw);cloudSet(STORAGE_KEYS.quests,raw);}
let questState=loadQuestState(); saveQuestState();
function questProgress(quest){return Math.min(questState.progress[quest.id]||0,quest.goal);}
function isQuestDone(quest){return questProgress(quest)>=quest.goal;}
function isQuestClaimed(quest){return Boolean(questState.claimed[quest.id]);}
function questsReadyToClaim(){return QUESTS.filter(q=>isQuestDone(q)&&!isQuestClaimed(q)).length;}
function bumpQuest(id,amount=1){const q=QUESTS.find(q=>q.id===id);if(!q||isQuestClaimed(q))return;const cur=questState.progress[id]||0;const nxt=Math.min(cur+amount,q.goal);if(nxt===cur)return;questState.progress[id]=nxt;saveQuestState();renderQuestBadge();if(cur<q.goal&&nxt>=q.goal)showToast('Задание «'+q.name+'» выполнено!');}
function raiseQuest(id,value){const q=QUESTS.find(q=>q.id===id);if(!q||isQuestClaimed(q))return;const cur=questState.progress[id]||0;if(value<=cur)return;questState.progress[id]=Math.min(value,q.goal);saveQuestState();renderQuestBadge();if(cur<q.goal&&value>=q.goal)showToast('Задание «'+q.name+'» выполнено!');}
function renderQuestBadge(){const badge=document.getElementById('questBadge');if(!badge)return;const ready=questsReadyToClaim();badge.textContent=ready;badge.classList.toggle('show',ready>0);}
function renderQuests(){document.getElementById('questDayLabel').textContent='Задания на '+questState.date+' · обновятся после полуночи';const list=document.getElementById('questList');list.innerHTML='';QUESTS.forEach(quest=>{const progress=questProgress(quest);const done=isQuestDone(quest);const claimed=isQuestClaimed(quest);const percent=Math.round((progress/quest.goal)*100);const item=document.createElement('div');item.className='quest-item'+(done?' done':'')+(claimed?' claimed':'');item.innerHTML='<div class="quest-top"><span class="quest-name">'+quest.name+'</span><span class="quest-reward">+'+quest.reward+' 🪙</span></div><div class="quest-desc">'+quest.desc+'</div><div class="quest-bar"><div class="quest-fill" style="width:'+percent+'%"></div></div><div class="quest-progress"><span>'+progress+' / '+quest.goal+'</span><span>'+(claimed?'✅ Получено':(done?'✔ Готово':'В процессе'))+'</span></div><button class="btn quest-claim '+(done&&!claimed?'btn-secondary':'btn-primary')+'" data-quest="'+quest.id+'"'+(done&&!claimed?'':' disabled')+'>'+(claimed?'Награда получена':'Забрать награду')+'</button>';list.appendChild(item);});list.querySelectorAll('.quest-claim').forEach(btn=>{btn.addEventListener('click',()=>claimQuest(btn.dataset.quest));});}
function claimQuest(id){const q=QUESTS.find(q=>q.id===id);if(!q||!isQuestDone(q)||isQuestClaimed(q))return;questState.claimed[id]=true;saveQuestState();soundManager.init();addGold(q.reward,true);triggerHaptic('notification','success');showToast('Награда получена: +'+q.reward+' грошей!');renderQuests();renderQuestBadge();}

/* --------------------------------------------------------------------------
   4. Game State & Logic (FIX #1: unified dice model)
   -------------------------------------------------------------------------- */
const TARGET_SCORE = 2000;
// playerTurnDice — «замороженный» на весь ход игрока набор из 6 кубиков вместе с их
// типами (special). Создаётся ровно один раз за ход; при перебросе меняется только value.
let gameState = { playerTotal:0, playerTurn:0, aiTotal:0, aiTurn:0, currentTurn:'player', isRolling:false, dice:[], rolledThisTurn:0, playerTurnDice:null };
let dieIdCounter = 0;
function getTableDice()    { return gameState.dice.filter(d => d.state === 'table'); }
function getSelectedDice() { return gameState.dice.filter(d => d.state === 'selected'); }
function getLockedDice()   { return gameState.dice.filter(d => d.state === 'locked'); }
function getOnTableDice()  { return gameState.dice.filter(d => d.state !== 'locked'); }
function lockSelectedDice() { getSelectedDice().forEach(die => { die.state = 'locked'; }); }
function selectionScore() { const r = evaluateDiceSelection(getSelectedDice().map(d => d.value)); return r.valid ? r.score : 0; }
function isSelectionValid() { const s = getSelectedDice(); if (s.length === 0) return false; const r = evaluateDiceSelection(s.map(d => d.value)); return r.valid && r.score > 0; }

function createDiceElement(dieObj) {
  const el = document.createElement('div'); el.className = 'die ' + dieObj.state;
  if (dieObj.special && dieObj.special !== 'ordinary') el.classList.add('special-' + dieObj.special);
  el.dataset.id = dieObj.id; el.dataset.value = dieObj.value; el.dataset.state = dieObj.state;
  for (let i = 0; i < 9; i++) { const pip = document.createElement('div'); pip.className = 'pip'; el.appendChild(pip); }
  return el;
}
function renderTable() {
  const rolledArea = document.getElementById('rolledDiceArea'), keptArea = document.getElementById('keptDiceArea');
  rolledArea.innerHTML = ''; keptArea.innerHTML = '';
  getOnTableDice().forEach(dieObj => rolledArea.appendChild(createDiceElement(dieObj)));
  getLockedDice().forEach(dieObj => keptArea.appendChild(createDiceElement(dieObj)));
  document.getElementById('playerTotalScore').textContent = gameState.playerTotal;
  document.getElementById('playerTurnScore').textContent = gameState.playerTurn;
  document.getElementById('playerProgress').style.width = Math.min(100, (gameState.playerTotal / TARGET_SCORE) * 100) + '%';
  document.getElementById('aiTotalScore').textContent = gameState.aiTotal;
  document.getElementById('aiTurnScore').textContent = gameState.aiTurn;
  document.getElementById('aiProgress').style.width = Math.min(100, (gameState.aiTotal / TARGET_SCORE) * 100) + '%';
  const playerCard = document.getElementById('playerCard'), aiCard = document.getElementById('aiCard');
  if (gameState.currentTurn === 'player') { playerCard.classList.add('active-turn'); aiCard.classList.remove('active-turn'); }
  else { aiCard.classList.add('active-turn'); playerCard.classList.remove('active-turn'); }
  updateControls();
}

function isZonkPause() { return document.getElementById('zonkOverlay').classList.contains('active'); }

function updateControls() {
  const rollBtn = document.getElementById('rollBtn'), bankBtn = document.getElementById('bankBtn');
  if (matchState !== 'playing' || gameState.currentTurn !== 'player' || gameState.isRolling || isZonkPause()) { rollBtn.disabled = true; bankBtn.disabled = true; return; }
  if (gameState.dice.length === 0) { rollBtn.disabled = false; bankBtn.disabled = true; return; }
  const selectionValid = isSelectionValid(), score = selectionScore();
  rollBtn.disabled = !selectionValid;
  bankBtn.disabled = !selectionValid || (gameState.playerTurn + score) <= 0;
}

function updateSelectionHint() {
  const comboText = document.getElementById('comboText');
  const selectedDice = getSelectedDice();
  if (selectedDice.length === 0) { comboText.textContent = 'Выберите кости: 1, 5 или три одинаковых'; return; }
  const evalResult = evaluateDiceSelection(selectedDice.map(d => d.value));
  if (evalResult.valid && evalResult.score > 0) comboText.textContent = 'Выбрано: +' + evalResult.score + ' очков (' + evalResult.comboName + ')';
  else comboText.textContent = 'Неполная комбинация — докликайте призовые кости';
}
/* --------------------------------------------------------------------------
   2e. UI helpers: toast, confirm, speech
   -------------------------------------------------------------------------- */
let toastTimer = null;
function showToast(text) { const toast = document.getElementById('toast'); toast.textContent = text; toast.classList.add('show'); if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2200); }
let confirmAction = null;
function openConfirm(title, html, action) { document.getElementById('confirmTitle').textContent = title; document.getElementById('confirmText').innerHTML = html; confirmAction = action; document.getElementById('confirmModal').classList.add('active'); }
function closeConfirm() { document.getElementById('confirmModal').classList.remove('active'); confirmAction = null; }
let speechTimer = null;
function sayText(text) { if (!text) return; const bubble = document.getElementById('speechBubble'); if (!bubble) return; bubble.textContent = text; bubble.classList.add('show'); if (speechTimer) clearTimeout(speechTimer); speechTimer = setTimeout(() => bubble.classList.remove('show'), 2600); }
function sayOpponent(kind) { if (!currentOpponent) return; const pool = (currentOpponent.lines && currentOpponent.lines[kind]) || []; if (!pool.length) return; sayText(pool[Math.floor(Math.random() * pool.length)]); }
function hideSpeech() { document.getElementById('speechBubble').classList.remove('show'); }

/* --------------------------------------------------------------------------
   2f. Screens navigation & matchmaking
   -------------------------------------------------------------------------- */
let currentOpponent = null;
let matchState = 'tavern'; // 'tavern' | 'playing' | 'over'

function showScreen(name) { document.getElementById('tavernScreen').classList.toggle('active', name === 'tavern'); document.getElementById('gameScreen').classList.toggle('active', name === 'game'); }
function resetBoard() { gameState.playerTotal=0;gameState.playerTurn=0;gameState.aiTotal=0;gameState.aiTurn=0;gameState.dice=[];gameState.playerTurnDice=null;gameState.rolledThisTurn=0;gameState.isRolling=false;gameState.currentTurn='player';document.getElementById('zonkOverlay').classList.remove('active');renderTable();}
function goToTavern() { matchState='tavern';currentOpponent=null;hideSpeech();clearNpcSelection();document.getElementById('gameOverModal').classList.remove('active');resetBoard();showScreen('tavern');clearActiveMatch();renderTavern();}

function leaveTable() {
  if (matchState === 'playing') { const bet = currentOpponent ? currentOpponent.bet : 0; openConfirm('Покинуть стол?', 'Вы уходите посреди партии. Ставка <strong>'+bet+'</strong> грошей сгорит, а партия будет засчитана как проигранная.<br>Точно уйти?', () => { bumpQuest('plays', 1); bumpAch('regular', 1); showToast('Ставка сгорела… Таверна вас ждёт.'); triggerHaptic('notification', 'warning'); goToTavern(); }); return; }
  goToTavern();
}

function startMatch(opponent) {
  if (matchState === 'playing') return;
  if (gold < opponent.bet) { showToast('Нужно '+opponent.bet+' грошей, а в кошеле лишь '+gold+'.'); triggerHaptic('notification', 'error'); return; }
  currentOpponent = opponent; addGold(-opponent.bet); matchState = 'playing'; clearNpcSelection();
  document.getElementById('aiName').textContent = opponent.name;
  document.getElementById('opponentBadge').textContent = opponent.fullName + ' · ставка ' + opponent.bet + ' 🪙';
  document.getElementById('gameOverModal').classList.remove('active');
  resetBoard(); showScreen('game');
  soundManager.init(); soundManager.playSelect(); triggerHaptic('impact', 'medium'); sayOpponent('start');
  startPlayerTurn();
}

/* --------------------------------------------------------------------------
   5. Turn Actions: Roll, Bank, Zonk
   -------------------------------------------------------------------------- */
function startPlayerTurn() {
  gameState.currentTurn='player'; gameState.playerTurn=0; gameState.dice=[]; gameState.rolledThisTurn=0;
  // ОСОБЫЕ КОСТИ: набор из 6 кубиков с их типами создаётся СТРОГО ОДИН РАЗ в начале хода
  // игрока, пока все 6 костей новые. Дальше меняются только значения (value), а не type.
  gameState.playerTurnDice = getPlayerDiceSet().map(t => ({ id: ++dieIdCounter, value: 0, special: t, state: 'table' }));
  document.getElementById('aiStatusText').textContent='Ваш ход! Бросьте кости.';
  document.getElementById('comboText').textContent='Нажмите «Бросить кости»';
  renderTable();
}

function rollDieValue(specialType) {
  // Честный рандом 1/6 для всех 4 ботов и обычных костей игрока.
  // Веса граней работают только у особых костей набора игрока.
  const type = specialType ? DICE_TYPES[specialType] : null;
  if (type && type.weights) { let totalWeight = 0; for (let v = 1; v <= 6; v++) totalWeight += type.weights[v]; let roll = Math.random() * totalWeight; for (let v = 1; v <= 6; v++) { roll -= type.weights[v]; if (roll < 0) return v; } return 6; }
  return Math.floor(Math.random() * 6) + 1;
}
function executeRoll() {
  if (gameState.isRolling || matchState !== 'playing' || isZonkPause()) return;
  const isPlayer = gameState.currentTurn === 'player';
  const isFirstRollOfTurn = gameState.dice.length === 0;
  const selectedDice = getSelectedDice();
  if (!isFirstRollOfTurn && selectedDice.length === 0) { updateSelectionHint(); updateControls(); return; }
  gameState.isRolling = true; updateControls();
  soundManager.playRoll(); triggerHaptic('impact', 'medium');
  if (selectedDice.length > 0) {
    const evalResult = evaluateDiceSelection(selectedDice.map(d => d.value));
    if (evalResult.valid && evalResult.score > 0) { if (isPlayer) { gameState.playerTurn += evalResult.score; registerPlayerCombo(selectedDice.map(d => d.value)); } else gameState.aiTurn += evalResult.score; }
    lockSelectedDice();
  }
  const lockedDice = getLockedDice();
  let diceToRollCount = getTableDice().length;
  let hotDice = false;
  if (diceToRollCount === 0) {
    if (lockedDice.length === 0) { diceToRollCount = 6; }
    else { hotDice = true; diceToRollCount = 6; gameState.dice = []; gameState.rolledThisTurn = 0; document.getElementById('comboText').textContent = '🔥 ГОРЯЧИЕ КОСТИ! Все 6 кубиков снова в игре!'; }
  }
  if (hotDice && isPlayer) bumpAch('hot_hand', 1);
  const rolledArea = document.getElementById('rolledDiceArea'); rolledArea.innerHTML = '';
  if (hotDice) document.getElementById('keptDiceArea').innerHTML = '';
  for (let i = 0; i < diceToRollCount; i++) { const placeholder = document.createElement('div'); placeholder.className = 'die rolling'; rolledArea.appendChild(placeholder); }
  const rollDelay = (isPlayer || aiSpeed >= 1) ? 500 : 150;
  setTimeout(() => {
    let newDice = [];
    if (isPlayer) {
      // ОСОБЫЕ КОСТИ ФИКСИРУЮТСЯ НА ВЕСЬ ХОД.
      // Набор из 6 кубиков с их типами (special) создаётся ровно один раз в начале хода
      // (см. startPlayerTurn). Здесь мы НИКОГДА не перезаписываем die.special / diceType —
      // при любом перебросе меняется ТОЛЬКО числовое значение (value). Поэтому особая
      // кость остаётся особой до конца хода, даже если на столе осталась 1, 2 или 3 кости.
      if (!gameState.playerTurnDice || gameState.playerTurnDice.length !== DICE_SET_SIZE) {
        gameState.playerTurnDice = getPlayerDiceSet().map(t => ({ id: ++dieIdCounter, value: 0, special: t, state: 'table' }));
      }
      const turnDice = gameState.playerTurnDice;
      if (isFirstRollOfTurn || hotDice) {
        // Бросок всех шести костей: перебрасываем значения, типы сохраняем.
        turnDice.forEach(d => { d.value = rollDieValue(d.special); d.state = 'table'; });
        newDice = turnDice.slice();
        gameState.dice = newDice;
      } else {
        // Переброс ТОЛЬКО оставшихся на столе кубиков — правим лишь их значение.
        const tableDice = getTableDice();
        tableDice.forEach(d => { d.value = rollDieValue(d.special); });
        newDice = tableDice;
        gameState.dice = lockedDice.concat(newDice);
      }
    } else {
      // Соперник: честный рандом 1/6, особых типов нет.
      for (let i = 0; i < diceToRollCount; i++) newDice.push({ id: ++dieIdCounter, value: rollDieValue(null), special: null, state: 'table' });
      gameState.dice = hotDice ? newDice : lockedDice.concat(newDice);
    }
    gameState.rolledThisTurn += diceToRollCount;
    gameState.isRolling = false;
    if (matchState !== 'playing') return;
    const currentRollValues = newDice.map(d => d.value);
    const hasScoring = hasScoringDice(currentRollValues);
    if (!hasScoring) { handleZonk(); }
    else {
      // «Безумный риск»: перебросил единственный оставшийся кубик и не поймал Зонк
      if (isPlayer && !hotDice && diceToRollCount === 1) unlockAch('mad_risk');
      if (isPlayer) { if (hotDice) document.getElementById('comboText').textContent = '🔥 Горячие кости! Снова выбирайте призовые кости'; else updateSelectionHint(); }
      renderTable(); saveActiveMatch();
      if (!isPlayer) { if (skipAI) { skipAI = false; processAITurn(); } else setTimeout(processAITurn, aiSpeed >= 1 ? 1200 : 300); }
    }
  }, rollDelay);
}

function handleZonk() {
  soundManager.playZonk(); triggerHaptic('notification', 'error');
  if (gameState.currentTurn === 'ai') sayOpponent('zonk');
  // «Мистер Удача»: Зонк пойман на первом же броске ходу игрока (все 6 кубиков)
  if (gameState.currentTurn === 'player' && gameState.rolledThisTurn === 6) unlockAch('mr_luck');
  const zonkOverlay = document.getElementById('zonkOverlay'); zonkOverlay.classList.add('active');
  document.getElementById('comboText').textContent = '💥 ЗОНК! Очки за ход сгорели!';
  if (gameState.currentTurn === 'player') gameState.playerTurn = 0; else gameState.aiTurn = 0;
  renderTable(); clearActiveMatch();
  setTimeout(() => { zonkOverlay.classList.remove('active'); if (matchState !== 'playing') return; if (gameState.currentTurn === 'player') startAITurn(); else startPlayerTurn(); }, 1800);
}
function bankPoints() {
  if (matchState !== 'playing' || gameState.currentTurn !== 'player') return;
  if (!isSelectionValid()) { updateSelectionHint(); return; }
  const bankedValues = getSelectedDice().map(d => d.value);
  const evalResult = evaluateDiceSelection(bankedValues);
  registerPlayerCombo(bankedValues);
  lockSelectedDice();
  gameState.dice = getLockedDice();
  const currentScoreToAdd = gameState.playerTurn + evalResult.score;
  gameState.playerTotal += currentScoreToAdd;
  gameState.playerTurn = 0;
  if (currentScoreToAdd >= 1000) unlockAch('fireproof');
  raiseQuest('hand', currentScoreToAdd);
  soundManager.playBank(); triggerHaptic('notification', 'success');
  document.getElementById('comboText').textContent = '💰 Забрано +' + currentScoreToAdd + ' очков в банк!';
  renderTable(); clearActiveMatch();
  if (currentScoreToAdd > 0) spawnFloatScore('+' + currentScoreToAdd, document.getElementById('keptDiceArea'));
  if (gameState.playerTotal >= TARGET_SCORE) { handleGameOver(true); }
  else { setTimeout(startAITurn, 1000); }
}

function handleDieClick(id) {
  if (matchState !== 'playing' || gameState.currentTurn !== 'player' || gameState.isRolling || isZonkPause()) return;
  const die = gameState.dice.find(d => d.id === id);
  if (!die || die.state === 'locked') return;
  die.state = (die.state === 'selected') ? 'table' : 'selected';
  soundManager.playSelect(); triggerHaptic('impact', 'light');
  renderTable(); updateSelectionHint();
  const score = selectionScore();
  if (score > 0) spawnFloatScore('+' + score, document.getElementById('rolledDiceArea'));
  saveActiveMatch();
}

/* --------------------------------------------------------------------------
   2g. AI decision making — честный рандом + ошибки по характеру соперника
   -------------------------------------------------------------------------- */
const AI_ERROR_CHANCE = { sivka: 0.65, ignat: 0.35, yashka: 0.18, lovchiy: 0.07 };
const AI_BLUNDER_LINES = {
  sivka: ['Гулять так гулять!', 'Авось пронесёт!'],
  ignat: ['Эх, живём раз! Кидаю!', 'Щи переждут — рискну!', 'Хватит, на щи уже есть...'],
  yashka: ['Гляди, как уездный бард умеет!', 'Ради потешки и рискну!'],
  lovchiy: ['Хм... Зараза. Была не была.', 'Хм. Азарт. Ненавижу.']
};
function aiErrorChance() { return currentOpponent ? (AI_ERROR_CHANCE[currentOpponent.id] || 0) : 0; }
function aiBlunderRoll() { return Math.random() < aiErrorChance(); }
function sayAIBlunder() { if (!currentOpponent) return; const pool = AI_BLUNDER_LINES[currentOpponent.id] || []; if (!pool.length) return; sayText(pool[Math.floor(Math.random() * pool.length)]); }

function aiDecideBank(turnScore, totalScore, remainingDice) {
  const style = currentOpponent ? currentOpponent.styleType : 'balanced';
  const id = currentOpponent ? currentOpponent.id : '';
  const playerLead = gameState.playerTotal - gameState.aiTotal;
  const toTarget = TARGET_SCORE - totalScore;
  if (totalScore >= TARGET_SCORE) return true;

  // Поведенческие ошибки по характеру (реплика уходит в speechBubble)
  if (aiBlunderRoll()) {
    if (id === 'sivka') {
      if (remainingDice <= 2 || turnScore < 500 || playerLead < 0) { sayAIBlunder(); return false; }
      return true;
    }
    if (id === 'ignat') {
      if (totalScore >= 1700) return turnScore >= 300;
      if (turnScore >= 200 && turnScore <= 250) { sayAIBlunder(); return true; }
      if (remainingDice <= 2) { sayAIBlunder(); return false; }
      return false;
    }
    if (id === 'yashka') {
      if (turnScore < 500) { sayAIBlunder(); return false; }
      return true;
    }
    if (id === 'lovchiy') {
      if (playerLead > 400 && remainingDice > 1) { sayAIBlunder(); return false; }
      return turnScore >= 300;
    }
  }

  if (remainingDice === 0) return false;
  switch (style) {
    case 'reckless': if (turnScore >= 500) return true; if (turnScore >= 300 && remainingDice <= 1) return true; return false;
    case 'balanced': if (turnScore >= 320) return true; if (remainingDice <= 2 && turnScore >= 200) return true; if (remainingDice <= 1) return true; if (toTarget <= 300 && turnScore >= toTarget) return true; return false;
    case 'cautious': { const behind = playerLead > 250; if (turnScore >= (behind ? 450 : 280)) return true; if (remainingDice <= 2) return true; if (!behind && remainingDice <= 4 && turnScore >= 200) return true; if (toTarget <= 300 && turnScore >= toTarget) return true; return false; }
    case 'gambler': { const endgame = totalScore >= 1300 || remainingDice <= 2; if (turnScore >= (endgame ? 600 : 400)) return true; if (toTarget <= 450 && turnScore >= toTarget) return true; return false; }
    default: return turnScore >= 300;
  }
}
/* --------------------------------------------------------------------------
   FIX #5: AI Speed + Skip, and FIX #6: Auto-save Active Match
   -------------------------------------------------------------------------- */
let aiSpeed = parseFloat(localStorage.getItem(STORAGE_KEYS.aiSpeed) || '1');
if (!Number.isFinite(aiSpeed) || aiSpeed < 0.2) aiSpeed = 1;
let skipAI = false;

function updateSpeedToggleUI() {
  const toggle = document.getElementById('aiSpeedToggle');
  if (toggle) { toggle.textContent = aiSpeed >= 1 ? '1x' : '⚡'; toggle.classList.toggle('fast', aiSpeed < 1); }
}
function toggleAiSpeed() {
  aiSpeed = aiSpeed >= 1 ? 0.25 : 1;
  localStorage.setItem(STORAGE_KEYS.aiSpeed, String(aiSpeed));
  updateSpeedToggleUI();
}
function skipAITurn() { if (matchState === 'playing' && gameState.currentTurn === 'ai' && !gameState.isRolling && !isZonkPause()) { skipAI = true; } }

function updateSkipButton() {
  const btn = document.getElementById('aiSkipBtn');
  if (!btn) return;
  btn.classList.toggle('visible', matchState === 'playing' && gameState.currentTurn === 'ai' && !gameState.isRolling && !isZonkPause());
}

function saveActiveMatch() {
  if (matchState !== 'playing' || !currentOpponent) return;
  const data = {
    opponentId: currentOpponent.id,
    playerTotal: gameState.playerTotal, aiTotal: gameState.aiTotal,
    playerTurn: gameState.playerTurn, aiTurn: gameState.aiTurn,
    currentTurn: gameState.currentTurn, rolledThisTurn: gameState.rolledThisTurn,
    dice: gameState.dice.map(d => ({ id: d.id, value: d.value, special: d.special, state: d.state })),
    playerTurnDice: (gameState.playerTurnDice || []).map(d => ({ id: d.id, value: d.value, special: d.special, state: d.state })),
    goldBeforeBet: gold + currentOpponent.bet
  };
  try { localStorage.setItem(STORAGE_KEYS.activeMatch, JSON.stringify(data)); } catch(e) {}
}

function clearActiveMatch() { localStorage.removeItem(STORAGE_KEYS.activeMatch); }

function loadActiveMatch() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.activeMatch);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !data.opponentId) return false;
    const opp = OPPONENTS.find(o => o.id === data.opponentId);
    if (!opp || gold < opp.bet) { clearActiveMatch(); return false; }
    currentOpponent = opp;
    matchState = 'playing';
    gameState.playerTotal = data.playerTotal || 0;
    gameState.aiTotal = data.aiTotal || 0;
    gameState.playerTurn = data.playerTurn || 0;
    gameState.aiTurn = data.aiTurn || 0;
    gameState.currentTurn = data.currentTurn || 'player';
    gameState.rolledThisTurn = data.rolledThisTurn || 0;
    // Восстанавливаем «замороженный» набор из 6 костей с типами (если сохранён),
    // чтобы особые кости не терялись после перезагрузки страницы.
    gameState.playerTurnDice = (Array.isArray(data.playerTurnDice) && data.playerTurnDice.length === DICE_SET_SIZE)
      ? data.playerTurnDice.map(d => ({ id: d.id, value: d.value, special: d.special || 'ordinary', state: d.state || 'table' }))
      : null;
    gameState.dice = (data.dice || []).map(d => {
      const obj = { id: d.id, value: d.value, special: d.special || null, state: d.state };
      if (gameState.playerTurnDice) {
        const shared = gameState.playerTurnDice.find(t => t.id === d.id);
        if (shared) { shared.value = obj.value; shared.state = obj.state; return shared; }
      }
      return obj;
    });
    dieIdCounter = gameState.dice.concat(gameState.playerTurnDice || []).reduce((max, d) => Math.max(max, d.id), 0);
    gameState.isRolling = false;
    if (data.goldBeforeBet && data.goldBeforeBet > gold) addGold(-(data.goldBeforeBet - gold));
    document.getElementById('aiName').textContent = opp.name;
    document.getElementById('opponentBadge').textContent = opp.fullName + ' · ставка ' + opp.bet + ' 🪙';
    document.getElementById('gameOverModal').classList.remove('active');
    showScreen('game'); renderTable();
    // Полное сохранение незавершённого хода: если в сохранении остались кости на столе,
    // НЕ начинаем ход заново, а продолжаем с восстановленного состояния (playerTurn/dice/playerTurnDice/rolledThisTurn).
    if (gameState.currentTurn === 'player') {
      if (gameState.dice.length === 0) { startPlayerTurn(); }
      else {
        document.getElementById('aiStatusText').textContent = 'Ваш ход! Продолжайте бросок.';
        updateSelectionHint(); renderTable();
      }
    } else {
      if (gameState.dice.length === 0) { startAITurn(); }
      else {
        document.getElementById('aiStatusText').textContent = opp.name + ' продолжает ход…';
        document.getElementById('comboText').textContent = 'Ход соперника: ' + opp.name;
        renderTable();
        setTimeout(processAITurn, aiSpeed >= 1 ? 900 : 250);
      }
    }
    updateSkipButton(); updateSpeedToggleUI();
    return true;
  } catch(e) { clearActiveMatch(); return false; }
}
/* --------------------------------------------------------------------------
   6. AI Strategy Logic with speed control
   -------------------------------------------------------------------------- */
function startAITurn() {
  if (matchState !== 'playing') return;
  const name = currentOpponent ? currentOpponent.name : 'Соперник';
  gameState.currentTurn = 'ai'; gameState.aiTurn = 0; gameState.dice = []; gameState.playerTurnDice = null; gameState.rolledThisTurn = 0;
  document.getElementById('aiStatusText').textContent = name + ' размышляет…';
  document.getElementById('comboText').textContent = 'Ход соперника: ' + name;
  renderTable(); updateSkipButton(); saveActiveMatch();
  const delay = aiSpeed >= 1 ? 1000 : 250;
  if (skipAI) { skipAI = false; executeRoll(); } else setTimeout(executeRoll, delay);
}

function processAITurn() {
  if (matchState !== 'playing' || gameState.currentTurn !== 'ai') return;
  const name = currentOpponent ? currentOpponent.name : 'Соперник';
  const rolledDice = getTableDice();
  const scoringDiceIds = selectOptimalDiceForAI(rolledDice);
  scoringDiceIds.forEach(id => { const d = gameState.dice.find(item => item.id === id); if (d) d.state = 'selected'; });
  let selectedDice = getSelectedDice();
  let evalResult = evaluateDiceSelection(selectedDice.map(d => d.value));
  if (selectedDice.length === 0 || !evalResult.valid || evalResult.score <= 0) {
    // Страховка: ИИ обязан взять хотя бы одну призовую кость
    gameState.dice.forEach(d => { if (d.state === 'selected') d.state = 'table'; });
    buildFallbackAISelection(rolledDice).forEach(id => { const d = gameState.dice.find(item => item.id === id); if (d) d.state = 'selected'; });
    selectedDice = getSelectedDice();
    evalResult = evaluateDiceSelection(selectedDice.map(d => d.value));
  }
  document.getElementById('comboText').textContent = name + ' взял +' + evalResult.score + ' очков!';
  soundManager.playSelect(); renderTable(); saveActiveMatch(); updateSkipButton();
  if (evalResult.score > 0) spawnFloatScore('+' + evalResult.score, document.getElementById('rolledDiceArea'));
  const potentialTurnScore = gameState.aiTurn + evalResult.score;
  const potentialTotalScore = gameState.aiTotal + potentialTurnScore;
  const remainingCount = getTableDice().length;
  if (remainingCount === 0) {
    sayOpponent('luck');
    document.getElementById('aiStatusText').textContent = name + ': Горячие кости! Бросает все шесть снова!';
    const d = aiSpeed >= 1 ? 1500 : 350;
    if (skipAI) { skipAI = false; executeRoll(); } else setTimeout(executeRoll, d);
    return;
  }
  if (aiDecideBank(potentialTurnScore, potentialTotalScore, remainingCount)) {
    document.getElementById('aiStatusText').textContent = name + ' забирает ' + potentialTurnScore + ' в банк.';
    sayOpponent('bank');
    const d = aiSpeed >= 1 ? 1200 : 300;
    if (skipAI) { skipAI = false; bankAIPoints(potentialTurnScore); } else setTimeout(() => bankAIPoints(potentialTurnScore), d);
  } else {
    document.getElementById('aiStatusText').textContent = name + ' рискует и бросает снова!';
    sayOpponent(evalResult.score >= 300 ? 'luck' : 'risky');
    const d = aiSpeed >= 1 ? 1400 : 350;
    if (skipAI) { skipAI = false; executeRoll(); } else setTimeout(executeRoll, d);
  }
}

function buildFallbackAISelection(rolledDice) {
  const counts = [0,0,0,0,0,0,0]; rolledDice.forEach(d => counts[d.value]++);
  const ids = [];
  for (let v = 1; v <= 6; v++) { if (counts[v] >= 3) rolledDice.filter(d => d.value === v).slice(0, 3).forEach(d => ids.push(d.id)); }
  if (!ids.length) { const one = rolledDice.find(d => d.value === 1) || rolledDice.find(d => d.value === 5); if (one) ids.push(one.id); }
  return ids;
}

function selectSmallStraightForAI(rolledDice, seq) {
  const ids = [], used = [];
  seq.forEach(v => { const d = rolledDice.find(die => die.value === v && !used.includes(die.id)); if (d) { used.push(d.id); ids.push(d.id); } });
  const extra = rolledDice.find(die => !used.includes(die.id) && (die.value === 1 || die.value === 5));
  if (extra) ids.push(extra.id);
  return ids;
}

function selectOptimalDiceForAI(rolledDice) {
  const values = rolledDice.map(d => d.value), counts = [0,0,0,0,0,0,0]; values.forEach(v => counts[v]++);
  const selectedIds = [];
  if (rolledDice.length === 6) {
    if (counts[1]===1&&counts[2]===1&&counts[3]===1&&counts[4]===1&&counts[5]===1&&counts[6]===1) return rolledDice.map(d => d.id);
    // Малые стриты: берём только 5 костей стрита (+1 или +5, если есть) — лишняя 6-я кость не считается
    if (counts[1]>=1&&counts[2]>=1&&counts[3]>=1&&counts[4]>=1&&counts[5]>=1) return selectSmallStraightForAI(rolledDice, [1,2,3,4,5]);
    if (counts[2]>=1&&counts[3]>=1&&counts[4]>=1&&counts[5]>=1&&counts[6]>=1) return selectSmallStraightForAI(rolledDice, [2,3,4,5,6]);
    if (counts.filter(c => c === 2).length === 3) return rolledDice.map(d => d.id);
  }
  for (let val = 1; val <= 6; val++) { if (counts[val] >= 3) { rolledDice.filter(d => d.value === val).forEach(d => selectedIds.push(d.id)); } }
  const scarceSingles = [];
  rolledDice.forEach(d => { if (!selectedIds.includes(d.id) && (d.value === 1 || d.value === 5)) scarceSingles.push(d); });
  scarceSingles.forEach(d => selectedIds.push(d.id));

  // Разница характеров: азартный ИИ «забирает все призовые кости подряд» — на переброс остаётся
  // минимум кубиков. Расчётливый (не в режиме ошибки) оставляет одну мелкую «5», чтобы в игре
  // оставалось больше кубиков и риск зонка был ниже.
  const likelyContinues = gameState.aiTurn < 250;
  if (!aiBlunderRoll() && likelyContinues && scarceSingles.length > 0 && selectedIds.length > 1 && (rolledDice.length - selectedIds.length) >= 1) {
    const spare = scarceSingles.filter(d => d.value === 5).pop();
    if (spare) selectedIds.splice(selectedIds.indexOf(spare.id), 1);
  }
  return selectedIds;
}

function bankAIPoints(turnScore) {
  if (matchState !== 'playing') return;
  lockSelectedDice(); gameState.dice = getLockedDice();
  gameState.aiTotal += turnScore; gameState.aiTurn = 0;
  soundManager.playBank(); renderTable(); clearActiveMatch(); updateSkipButton();
  if (gameState.aiTotal >= TARGET_SCORE) { handleGameOver(false); }
  else { setTimeout(startPlayerTurn, 1000); }
}

function handleGameOver(isPlayerWin) {
  if (matchState !== 'playing') return;
  matchState = 'over'; clearActiveMatch();
  const opponent = currentOpponent, bet = opponent ? opponent.bet : 0;
  const modal = document.getElementById('gameOverModal'), title = document.getElementById('gameOverTitle'), msg = document.getElementById('gameOverMessage'), purse = document.getElementById('gameOverPurse');
  bumpQuest('plays', 1);
  bumpAch('regular', 1);
  if (isPlayerWin) { winsCount++; localStorage.setItem(STORAGE_KEYS.wins, String(winsCount)); cloudSet(STORAGE_KEYS.wins, String(winsCount)); bumpQuest('wins', 1); bumpAch('first_win', 1); raiseAch('county_thunder', winsCount); const beatAchId = opponent ? OPPONENT_ACHIEVEMENTS[opponent.id] : null; if (beatAchId) bumpAch(beatAchId, 1); const payout = bet * 2; addGold(payout, true); title.textContent = '🎉 ВЫ ПОБЕДИЛИ!'; title.style.color = '#ffd700'; msg.innerHTML = 'Поздравляем, <strong>'+playerName+'</strong>! Вы обыграли <strong>'+opponent.fullName+'</strong> со счётом <strong>'+gameState.playerTotal+'</strong> : '+gameState.aiTotal+'.'; purse.innerHTML = '<h4>💰 Кошель</h4>Победа: <strong>+'+payout+' грошей</strong> (ставка '+bet+' × 2).<br>В кошеле теперь <strong>'+gold+'</strong> грошей.'; triggerHaptic('notification','success'); sayOpponent('lose'); }
  else { title.textContent = '💀 ПОРАЖЕНИЕ!'; title.style.color = '#ff3333'; msg.innerHTML = '<strong>'+opponent.fullName+'</strong> победил со счётом <strong>'+gameState.aiTotal+'</strong> : '+gameState.playerTotal+'.'; purse.innerHTML = '<h4>💰 Кошель</h4>Ставка <strong>'+bet+'</strong> грошей досталась сопернику.<br>В кошеле осталось <strong>'+gold+'</strong> грошей.'; triggerHaptic('notification','error'); sayOpponent('win'); }
  renderQuestBadge(); updateHeader(); modal.classList.add('active'); updateSkipButton();
}
/* --------------------------------------------------------------------------
   7. UI Event Wiring & Bootstrap
   -------------------------------------------------------------------------- */
document.getElementById('rolledDiceArea').addEventListener('click', (event) => {
  const dieEl = event.target.closest('.die');
  if (!dieEl || dieEl.classList.contains('locked') || dieEl.classList.contains('rolling')) return;
  const dieId = Number(dieEl.dataset.id);
  if (!Number.isFinite(dieId)) return;
  handleDieClick(dieId);
});

document.getElementById('rollBtn').addEventListener('click', () => { soundManager.init(); executeRoll(); });
document.getElementById('bankBtn').addEventListener('click', () => { soundManager.init(); bankPoints(); });
document.getElementById('muteBtn').addEventListener('click', () => { soundManager.init(); const isMuted = soundManager.toggleMute(); document.getElementById('muteBtn').textContent = isMuted ? '🔇' : '🔊'; });
document.getElementById('rulesBtn').addEventListener('click', () => { soundManager.init(); document.getElementById('rulesModal').classList.add('active'); });
document.getElementById('backToTavernBtn').addEventListener('click', () => { soundManager.init(); leaveTable(); });
document.getElementById('rulesBtnTavern').addEventListener('click', () => { soundManager.init(); document.getElementById('rulesModal').classList.add('active'); });
document.getElementById('closeRulesBtn').addEventListener('click', () => { document.getElementById('rulesModal').classList.remove('active'); });
document.getElementById('questsBtn').addEventListener('click', () => { soundManager.init(); renderQuests(); document.getElementById('questsModal').classList.add('active'); });
document.getElementById('closeQuestsBtn').addEventListener('click', () => { document.getElementById('questsModal').classList.remove('active'); renderTavern(); });
document.getElementById('upgradeBtn').addEventListener('click', () => { soundManager.init(); renderUpgrades(); document.getElementById('upgradeModal').classList.add('active'); });
document.getElementById('closeUpgradeBtn').addEventListener('click', () => { document.getElementById('upgradeModal').classList.remove('active'); renderTavern(); });
document.getElementById('diceShopBtn').addEventListener('click', () => { soundManager.init(); renderDiceShop(); document.getElementById('diceShopModal').classList.add('active'); });
document.getElementById('closeDiceShopBtn').addEventListener('click', () => { document.getElementById('diceShopModal').classList.remove('active'); renderTavern(); });
// Сезон 1: промокоды — свежий promos.js?t=Date.now() подтягивается и при открытии
// окна, и перед каждой проверкой кода, поэтому новые коды работают без перезапуска.
let promoCheckBusy = false;
function submitPromoInput() {
  const input = document.getElementById('promoInput');
  const btn = document.getElementById('promoApplyBtn');
  if (!input || promoCheckBusy) return;
  promoCheckBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  redeemPromo(input.value, true)
    .then((ok) => { if (ok) input.value = ''; })
    .catch(() => {})
    .finally(() => {
      promoCheckBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Ввести'; }
    });
}
document.getElementById('promoBtn').addEventListener('click', () => {
  soundManager.init(); renderPromoModal();
  document.getElementById('promoModal').classList.add('active');
  // Обновляем словарь кодов в фоне и показываем актуальное число доступных кодов
  refreshSeasonPromos(true).then(() => renderPromoCounters());
});
document.getElementById('closePromoBtn').addEventListener('click', () => { document.getElementById('promoModal').classList.remove('active'); renderTavern(); });
document.getElementById('promoApplyBtn').addEventListener('click', () => { soundManager.init(); submitPromoInput(); });
document.getElementById('promoInput').addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; submitPromoInput(); });
// Открытие окна друзей подтягивает актуальный счётчик/список/награды с сервера,
// но не чаще одного раза в 10 секунд (rate-limit внутри syncReferralsWithServer).
document.getElementById('friendsBtn').addEventListener('click', () => { soundManager.init(); renderFriendsModal(); document.getElementById('friendsModal').classList.add('active'); syncReferralsWithServer(false); });
document.getElementById('closeFriendsBtn').addEventListener('click', () => { document.getElementById('friendsModal').classList.remove('active'); renderTavern(); });
document.getElementById('refCopyBtn').addEventListener('click', () => { soundManager.init(); copyReferralLink(); });
// Ввод кода друга: только через сервер (локальной накрутки больше нет)
document.getElementById('refFriendBtn').addEventListener('click', () => { soundManager.init(); submitFriendCode(); });
document.getElementById('refFriendInput').addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; e.preventDefault(); submitFriendCode(); });
document.getElementById('achievementsBtn').addEventListener('click', () => { soundManager.init(); renderAchievements(); document.getElementById('achievementsModal').classList.add('active'); });
document.getElementById('closeAchievementsBtn').addEventListener('click', () => { document.getElementById('achievementsModal').classList.remove('active'); renderTavern(); });
document.getElementById('begBtn').addEventListener('click', () => { soundManager.init(); addGold(20, true); triggerHaptic('notification', 'success'); showToast('Сердобольный путник подал 20 грошей. Спасибо!'); });
document.getElementById('confirmOkBtn').addEventListener('click', () => { const action = confirmAction; closeConfirm(); if (typeof action === 'function') action(); });
document.getElementById('confirmCancelBtn').addEventListener('click', () => { closeConfirm(); });
document.getElementById('rematchBtn').addEventListener('click', () => { const opponent = currentOpponent; document.getElementById('gameOverModal').classList.remove('active'); if (!opponent) { goToTavern(); return; } if (gold < opponent.bet) { showToast('На реванш нужно '+opponent.bet+' грошей, а в кошеле лишь '+gold+'.'); goToTavern(); return; } startMatch(opponent); });
document.getElementById('toTavernBtn').addEventListener('click', () => { document.getElementById('gameOverModal').classList.remove('active'); goToTavern(); });

// FIX #5: AI Speed Toggle & Skip
document.getElementById('aiSpeedToggle').addEventListener('click', () => { toggleAiSpeed(); });
document.getElementById('aiSkipBtn').addEventListener('click', () => { skipAITurn(); });

/* --------------------------------------------------------------------------
   7b. Мобильные клавиатуры (Samsung / Android WebView, iOS Safari):
   при фокусе выводим поле ввода в центр экрана, чтобы клавиатура его не закрывала
   -------------------------------------------------------------------------- */
function installModalInputScrolling() {
  const inputs = document.querySelectorAll('.modal-card input');
  inputs.forEach(input => {
    input.addEventListener('focus', () => {
      setTimeout(() => {
        try { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        catch (e) { try { input.scrollIntoView(); } catch (err) {} }
      }, 250);
    });
  });
}

// Bootstrap
updateSpeedToggleUI(); updateSkipButton();
applyUpgrades(); updateHeader(); renderTavern(); renderTable();
showScreen('tavern');
// FIX #6: Restore active match on reload
if (!loadActiveMatch()) { showScreen('tavern'); }
// Сезон 1: промокоды/друзья/достижения + фоновая синхронизация прогресса с Telegram CloudStorage
activateStartParamReferral();
renderPromoModal();
renderFriendsModal();
renderAchievements();
checkPersistentAchievements(true);
installModalInputScrolling();
syncReferralsWithServer();
syncCloudProgress();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushCloudProgress(); });
window.addEventListener('pagehide', flushCloudProgress);