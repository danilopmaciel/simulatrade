(() => {
  'use strict';

  // ----- CONFIGURAÇÕES -----
  const cfg = {
    restUrl: 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=96',
    wsUrl: 'wss://fstream.binance.com/ws/btcusdt@kline_15m',
    initialCapital: 1000,
    tradeAmount: 10,
    leverage: 20,
    feeRate: 0.0004,
    maxCandles: 96
  };

  // ----- ESTADO -----
  const state = {
    candles: { times: [], open: [], high: [], low: [], close: [] },
    indicators: {},
    position: null,
    capital: cfg.initialCapital,
    ws: null,
    countdownId: null,
    running: false,
    discordEnabled: false,
    lastSignal: null
  };

  // ----- DOM REFERENCES -----
  const D = {
    chart: document.getElementById('chart'),
    countdown: document.getElementById('countdown'),
    btnToggle: document.getElementById('btnToggleBot'),
    btnTest: document.getElementById('btnTest'),
    btnDiscord: document.getElementById('btnDiscord'),
    btnToggleDiscord: document.getElementById('btnToggleDiscord'),
    webhook: document.getElementById('discordWebhook'),
    backtestPre: document.getElementById('backtestResult'),
    signalList: document.getElementById('signalList'),
    simBody: document.getElementById('simulationBody'),
    entryInfo: document.getElementById('entryInfo'),
    tpInfo: document.getElementById('takeProfitSuggestion'),
    slInfo: document.getElementById('stopSuggestion'),
    rrInfo: document.getElementById('riskReward'),
    capInfo: document.getElementById('currentCapitalDisplay'),
    logOutput: document.getElementById('logOutput')
  };

  // ----- LOG UTILS -----
  function log(type, msg) {
    const time = new Date().toLocaleTimeString();
    D.logOutput.textContent = `[${time}] ${type}: ${msg}\n` + D.logOutput.textContent;
    const container = D.logOutput.parentElement;
    if (container) container.scrollTop = 0;
  }

  function testNotification() {
    if (Notification.permission !== 'granted') {
      Notification.requestPermission().then(p => {
        if (p === 'granted') new Notification('Teste', { body: 'Notificação funciona!' });
      });
    } else {
      new Notification('Teste', { body: 'Notificação funciona!' });
    }
  }

  async function notifyDiscord(msg) {
    if (!state.discordEnabled) return;
    const url = D.webhook.value.trim();
    if (!url) { log('ERRO', 'Webhook não configurado'); return; }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: msg })
      });
      if (res.ok) log('OBS', 'Discord: mensagem enviada');
      else log('ERRO', `Discord status ${res.status}`);
    } catch (e) {
      log('ERRO', `Discord erro: ${e.message}`);
    }
  }

  // ----- INDICADORES -----
  function sma(a, p) { return a.map((v, i, arr) => i < p -1 ? null : arr.slice(i-p+1, i+1).reduce((s,x)=>s+x,0)/p); }
  function ema(a, p) { const k=2/(p+1); return a.map((v,i,arr)=>i? v*k + arr[i-1]*(1-k) : v); }
  function rsi(a,p){ const g=[],l=[]; for(let i=1;i<a.length;i++){ const d=a[i]-a[i-1]; g.push(d>0?d:0); l.push(d<0?-d:0);} const out=Array(a.length).fill(null); if(g.length<p) return out; let ag=g.slice(0,p).reduce((s,x)=>s+x,0)/p, al=l.slice(0,p).reduce((s,x)=>s+x,0)/p; out[p]=al===0?100:100-(100/(1+ag/al)); for(let i=p+1;i<a.length;i++){ ag=(ag*(p-1)+g[i-1])/p; al=(al*(p-1)+l[i-1])/p; out[i]=al===0?100:100-(100/(1+ag/al));} return out; }
  function bb(a,p,k){ const up=[],mid=[],dn=[]; for(let i=0;i<a.length;i++){ if(i<p-1){up.push(null);mid.push(null);dn.push(null);}else{const s=a.slice(i-p+1,i+1);const m=s.reduce((x,y)=>x+y,0)/p;const sd=Math.sqrt(s.reduce((x,y)=>x+(y-m)**2,0)/p);mid.push(m);up.push(m+k*sd);dn.push(m-k*sd);} } return { up, mid, dn }; }
  function macd(a,f,s,sg){ const ef=ema(a,f), es=ema(a,s); const line=ef.map((v,i)=>v-es[i]); return { line, sig: ema(line,sg) }; }

  // ----- RENDER CHART -----
  let plot;
  function renderChart(){
    const c=state.candles, ind=state.indicators;
    const data=[
      { x:c.times, open:c.open, high:c.high, low:c.low, close:c.close, type:'candlestick', name:'Candles' },
      { x:c.times, y:ind.sma5, mode:'lines', name:'SMA5' },
      { x:c.times, y:ind.sma10, mode:'lines', name:'SMA10' },
      { x:c.times, y:ind.bb.mid, mode:'lines', name:'BB Mid' },
      { x:c.times, y:ind.bb.up, mode:'lines', name:'BB Up' },
      { x:c.times, y:ind.bb.dn, mode:'lines', name:'BB Dn' },
      { x:c.times, y:ind.macd.line, mode:'lines', name:'MACD', yaxis:'y2' },
      { x:c.times, y:ind.macd.sig, mode:'lines', name:'Signal', yaxis:'y2' }
    ];
    const layout={ margin:{t:30,r:30,b:60,l:60}, xaxis:{title:'Hora',rangeslider:{visible:false}}, yaxis:{title:'Preço'}, yaxis2:{overlaying:'y',side:'right',title:'MACD'}, showlegend:true };
    if(plot) Plotly.react(D.chart,data,layout); else plot=Plotly.newPlot(D.chart,data,layout,{responsive:true});
  }

  // ----- BACKTEST -----
  function runBacktest(){
    const c=state.candles.close, ind=state.indicators; const lines=[];
    for(let i=1;i<c.length;i++){ const p=i-1; if([ind.sma5[p],ind.sma10[p],ind.rsi[p],ind.bb.dn[p],ind.bb.up[p],ind.macd.line[p],ind.macd.sig[p]].some(v=>v==null)) continue;
      const time=state.candles.times[p].toLocaleTimeString(); let sig='', sl=0, tp=0;
      if(ind.sma5[p]<=ind.sma10[p]&&ind.rsi[p]<70&&c[p]>ind.bb.dn[p]&&ind.macd.line[p]>ind.macd.sig[p]&&ind.sma5[i]>ind.sma10[i]){ sig='COMPRA'; sl=ind.bb.dn[p]*0.999; tp=c[p]+(c[p]-sl)*2; }
      else if(ind.sma5[p]>=ind.sma10[p]&&ind.rsi[p]>30&&c[p]<ind.bb.up[p]&&ind.macd.line[p]<ind.macd.sig[p]&&ind.sma5[i]<ind.sma10[i]){ sig='VENDA'; sl=ind.bb.up[p]*1.001; tp=c[p]-(sl-c[p])*2; }
      if(sig) lines.push(`${time} | ${sig} | SL:${Math.round(sl)} | TP:${Math.round(tp)}`);
    }
    D.backtestPre.textContent = lines.length?`Histórico de Sinais:\n${lines.join('\n')}`:'Nenhum sinal encontrado';
    log('OBS','Backtest concluído');
  }

  // ----- UPDATE UI -----
  function updateUI(){
    const pos=state.position;
    D.capInfo.textContent=`Capital Atual: $${state.capital.toFixed(2)}`;
    D.capInfo.className=`trade-info ${state.capital>cfg.initialCapital?'buy':state.capital<cfg.initialCapital?'sell':'neutral'}`;
    if(pos){
      D.entryInfo.textContent=`Posição:${pos.side} @ ${pos.entryPrice.toFixed(2)}`;
      D.entryInfo.className=`trade-info ${pos.side==='COMPRA'?'buy':'sell'}`;
      D.tpInfo.textContent=`Take Profit: ${pos.takeProfit.toFixed(2)}`;
      D.slInfo.textContent=`Stop Loss: ${pos.stopLoss.toFixed(2)}`;
    } else {
      D.entryInfo.textContent='Nenhuma posição simulada';
      D.entryInfo.className='trade-info neutral';
      D.tpInfo.textContent='Take Profit: -';
      D.slInfo.textContent='Stop Loss: -';
    }
    D.rrInfo.textContent='Risco/Recompensa: -';
  }

  // ----- COUNTDOWN -----
  function startCountdown(){
    clearInterval(state.countdownId);
    state.countdownId=setInterval(()=>{
      const now=Date.now(), interval=15*60e3;
      const next=Math.ceil(now/interval)*interval;
      const d=next-now;
      const m=String(Math.floor(d/60000)).padStart(2,'0');
      const s=String(Math.floor((d%60000)/1000)).padStart(2,'0');
      D.countdown.textContent=`Próximo candle em: ${m}:${s}`;
    },1000);
  }

  // ----- WEBSOCKET -----
  function connectWS(){
    if(state.ws&&state.ws.readyState===WebSocket.OPEN) return;
    state.ws=new WebSocket(cfg.wsUrl);
    state.ws.onopen=() => { log('OBS','WebSocket conectado'); startCountdown(); };
    state.ws.onmessage=ev => {
      if(!state.running) return;
      const k=JSON.parse(ev.data).k;
      if(k.x) { // candle fechado
        state.candles.times.push(new Date(k.t));
        state.candles.open.push(+k.o);
        state.candles.high.push(+k.h);
        state.candles.low.push(+k.l);
        state.candles.close.push(+k.c);
        while(state.candles.times.length>cfg.maxCandles) {
          for(const arr of Object.values(state.candles)) arr.shift();
        }
        // recalcula indicadores
        state.indicators.sma5=sma(state.candles.close,5);
        state.indicators.sma10=sma(state.candles.close,10);
        state.indicators.rsi=rsi(state.candles.close,14);
        state.indicators.bb=bb(state.candles.close,20,2);
        state.indicators.macd=macd(state.candles.close,12,26,9);

        // sinal de trade
        const i=state.candles.close.length-1;
        let signal=null;
        if(state.indicators.sma5[i-1]<=state.indicators.sma10[i-1] && state.indicators.rsi[i-1]<70 && state.indicators.macd.line[i-1]>state.indicators.macd.sig[i-1] && state.indicators.sma5[i]>state.indicators.sma10[i]) signal='COMPRA';
        if(state.indicators.sma5[i-1]>=state.indicators.sma10[i-1] && state.indicators.rsi[i-1]>30 && state.indicators.macd.line[i-1]<state.indicators.macd.sig[i-1] && state.indicators.sma5[i]<state.indicators.sma10[i]) signal='VENDA';
        if(signal && signal!==state.lastSignal) {
          state.lastSignal=signal;
          log('OBS',`Sinal ${signal}`);
          notifyDiscord(`SINAL ${signal}`);
        }

        renderChart(); updateUI();
      }
    };
    state.ws.onerror=e=>log('ERRO',e.message||e);
    state.ws.onclose=() => log('OBS','WebSocket desconectado');
  }
  function disconnectWS(){ if(state.ws) state.ws.close(); clearInterval(state.countdownId); }

  // ----- CONTROLE -----
  function startBot(){
    state.running=true;
    state.capital=cfg.initialCapital;
    D.btnTest.disabled=false;
    D.btnDiscord.disabled=false;
    D.btnToggleDiscord.disabled=false;
    D.btnToggle.textContent='Desligar Simulador';
    log('OBS','Simulador ligado');
    connectWS();
  }
  function stopBot(){
    state.running=false;
    D.btnToggle.textContent='Ligar Simulador';
    disconnectWS();
    log('OBS','Simulador desligado');
  }
  D.btnToggle.addEventListener('click',()=> state.running? stopBot(): startBot());
  D.btnTest.addEventListener('click',testNotification);
  D.btnDiscord.addEventListener('click',()=>notifyDiscord('Teste Discord'));
  D.btnToggleDiscord.addEventListener('click',()=>{
    state.discordEnabled=!state.discordEnabled;
    D.btnToggleDiscord.textContent=state.discordEnabled?'Desativar Discord':'Ativar Notificações Discord';
    log('OBS',`Discord ${state.discordEnabled?'ativado':'desativado'}`);
  });

  // ----- INIT -----
  (async()=>{
    try {
      const resp=await fetch(cfg.restUrl);
      const data=await resp.json();
      data.forEach(c=>{
        state.candles.times.push(new Date(c[0]));
        state.candles.open.push(+c[1]);
        state.candles.high.push(+c[2]);
        state.candles.low.push(+c[3]);
        state.candles.close.push(+c[4]);
      });
      state.indicators={
        sma5:sma(state.candles.close,5),
        sma10:sma(state.candles.close,10),
        rsi:rsi(state.candles.close,14),
        bb:bb(state.candles.close,20,2),
        macd:macd(state.candles.close,12,26,9)
      };
      renderChart(); runBacktest(); updateUI(); log('OBS','Init concluído');
    } catch (e) { log('ERRO',`Init falhou: ${e.message}`); }
  })();
})();
