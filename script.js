(() => {
  'use strict';

  // ----- CONFIGURAÇÕES -----
  const cfg = {
    restUrl: 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=96',
    wsUrl:   'wss://fstream.binance.com/ws/btcusdt@kline_15m',
    initialCapital: 1000,
    tradeAmount:    10,
    leverage:       20,
    feeRate:        0.0004,
    maxCandles:     96
  };

  // ----- ESTADO -----
  const state = {
    candles: { times: [], open: [], high: [], low: [], close: [] },
    indicators: {},
    position: null,
    capital: cfg.initialCapital,
    ws: null,
    countdownId: null,
    isRunning: false,
    discordEnabled: false,
    lastSignal: null
  };

  // ----- DOM REFERENCES -----
  const D = {
    chart:        document.getElementById('chart'),
    countdown:    document.getElementById('countdown'),
    toggleBot:    document.getElementById('btnToggleBot'),
    testBtn:      document.getElementById('btnTest'),
    discordBtn:   document.getElementById('btnDiscord'),
    toggleDiscord:document.getElementById('btnToggleDiscord'),
    webhook:      document.getElementById('discordWebhook'),
    backtestPre:  document.getElementById('backtestResult'),
    signalList:   document.getElementById('signalList'),
    simBody:      document.getElementById('simulationBody'),
    entryInfo:    document.getElementById('entryInfo'),
    tpInfo:       document.getElementById('takeProfitSuggestion'),
    slInfo:       document.getElementById('stopSuggestion'),
    rrInfo:       document.getElementById('riskReward'),
    capInfo:      document.getElementById('currentCapitalDisplay'),
    log:          document.getElementById('logOutput')
  };

  // ----- LOG (newest first) -----
  function log(type, msg) {
    const t = new Date().toLocaleTimeString();
    D.log.textContent = `[${t}] ${type}: ${msg}\n` + D.log.textContent;
  }

  // ----- NOTIFICATIONS -----
  function testNotification() {
    if (Notification.permission !== 'granted') {
      Notification.requestPermission().then(p => p === 'granted' && new Notification('Teste', { body: 'Notificação funciona!' }));
    } else {
      new Notification('Teste', { body: 'Notificação funciona!' });
    }
  }

  async function notifyDiscord(msg) {
    if (!state.discordEnabled) return;
    const webhook = D.webhook.value.trim();
    if (!webhook) { log('ERRO', 'Webhook Discord não configurado'); return; }
    try {
      const res = await fetch(webhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: msg })
      });
      if (res.ok) log('OBS', 'Discord: mensagem enviada');
      else log('ERRO', `Discord status ${res.status}`);
    } catch (err) {
      log('ERRO', `Discord: ${err.message}`);
    }
  }

  // ----- INDICATORS -----
  function SMA(a,p){ return a.map((_,i,A)=> i<p-1?null:A.slice(i-p+1,i+1).reduce((s,v)=>s+v,0)/p); }
  function RSI(a,p){ const g=[],l=[]; for(let i=1;i<a.length;i++){ const d=a[i]-a[i-1]; g.push(Math.max(d,0)); l.push(Math.max(-d,0)); } const out=Array(a.length).fill(null); if(g.length<p) return out; let ag=g.slice(0,p).reduce((s,v)=>s+v,0)/p; let al=l.slice(0,p).reduce((s,v)=>s+v,0)/p; out[p]=al===0?100:100-(100/(1+ag/al)); for(let i=p+1;i<a.length;i++){ ag=(ag*(p-1)+g[i-1])/p; al=(al*(p-1)+l[i-1])/p; out[i]=al===0?100:100-(100/(1+ag/al)); } return out; }
  function BB(a,p,k){ const up=[],md=[],dn=[]; for(let i=0;i<a.length;i++){ if(i<p-1){up.push(null);md.push(null);dn.push(null);} else { const s=a.slice(i-p+1,i+1); const m=s.reduce((x,y)=>x+y,0)/p; const sd=Math.sqrt(s.reduce((x,y)=>x+(y-m)**2,0)/p); md.push(m);up.push(m+k*sd);dn.push(m-k*sd);} } return { up,md,dn }; }
  function EMA(a,p){ const k=2/(p+1); return a.map((v,i,A)=> i? v*k + A[i-1]*(1-k) : v ); }
  function MACD(a,f,s,sg){ const ef=EMA(a,f), es=EMA(a,s); const line=ef.map((v,i)=>v-es[i]); return { line,signal:EMA(line,sg) }; }

  // ----- RENDER CHART -----
  let plot;
  function renderChart(){ const c=state.candles,ind=state.indicators; const traces=[
      {x:c.times,open:c.open,high:c.high,low:c.low,close:c.close,type:'candlestick',name:'Candles'},
      {x:c.times,y:ind.sma5,mode:'lines',name:'SMA5'},
      {x:c.times,y:ind.sma10,mode:'lines',name:'SMA10'},
      {x:c.times,y:ind.bb.up,mode:'lines',name:'BB Up'},
      {x:c.times,y:ind.bb.md,mode:'lines',name:'BB Mid'},
      {x:c.times,y:ind.bb.dn,mode:'lines',name:'BB Dn'},
      {x:c.times,y:ind.macd.line,mode:'lines',name:'MACD',yaxis:'y2'},
      {x:c.times,y:ind.macd.signal,mode:'lines',name:'Signal',yaxis:'y2'}
    ];
    const layout={ margin:{t:30,r:30,b:60,l:60}, xaxis:{title:'Hora',rangeslider:{visible:false}}, yaxis:{title:'Preço'}, yaxis2:{overlaying:'y',side:'right',title:'MACD'}, showlegend:true };
    if(plot) Plotly.react(D.chart,traces,layout); else plot=Plotly.newPlot(D.chart,traces,layout,{responsive:true}); }

  // ----- BACKTEST WITH SL/TP SUGGESTIONS -----
  function runBacktest(){ const c=state.candles.close,ind=state.indicators; const lines=[]; for(let i=1;i<c.length;i++){ const p=i-1; if([ind.sma5[p],ind.sma10[p],ind.rsi[p],ind.bb.dn[p],ind.bb.up[p],ind.macd.line[p],ind.macd.signal[p]].some(v=>v==null)) continue; const time=state.candles.times[p].toLocaleTimeString(); let sig='', sl=0, tp=0; if(ind.sma5[p]<=ind.sma10[p]&&ind.rsi[p]<70&&c[p]>ind.bb.dn[p]&&ind.macd.line[p]>ind.macd.signal[p]&&ind.sma5[i]>ind.sma10[i]){ sig='COMPRA'; sl=ind.bb.dn[p]*0.999; tp=c[p]+(c[p]-sl)*2; } else if(ind.sma5[p]>=ind.sma10[p]&&ind.rsi[p]>30&&c[p]<ind.bb.up[p]&&ind.macd.line[p]<ind.macd.signal[p]&&ind.sma5[i]<ind.sma10[i]) { sig='VENDA'; sl=ind.bb.up[p]*1.001; tp=c[p]-(sl-c[p])*2; } if(sig) lines.push(`${time} | ${sig} | SL: ${Math.round(sl)} | TP: ${Math.round(tp)}`);} D.backtestPre.textContent = lines.length?`Histórico de Sinais:\n${lines.join('\n')}`:'Nenhum sinal encontrado'; log('OBS','Backtest concluído com sugestões'); }

  // ----- UPDATE UI -----
  function updateUI(){ const pos=state.position; D.capInfo.textContent=`Capital Atual: $${state.capital.toFixed(2)}`; D.capInfo.className=`trade-info ${state.capital>cfg.initialCapital?'buy':state.capital<cfg.initialCapital?'sell':'neutral'}`; if(pos){ D.entryInfo.textContent=`Posição: ${pos.side} @ ${pos.entryPrice.toFixed(2)}`; D.entryInfo.className=`trade-info ${pos.side==='COMPRA'?'buy':'sell'}`; D.tpInfo.textContent=`Take Profit: ${pos.takeProfit.toFixed(2)}`; D.slInfo.textContent=`Stop Loss: ${pos.stopLoss.toFixed(2)}`; } else { D.entryInfo.textContent='Nenhuma posição simulada'; D.entryInfo.className='trade-info neutral'; D.tpInfo.textContent='Take Profit: -'; D.slInfo.textContent='Stop Loss: -'; } D.rrInfo.textContent='Risco/Recompensa: -'; }

  // ----- COUNTDOWN -----
  function startCountdown(){ clearInterval(state.countdownId); state.countdownId=setInterval(()=>{ const now=Date.now(), pr=15*60e3; const next=Math.ceil(now/pr)*pr; const d=next-now; const m=String(Math.floor(d/60000)).padStart(2,'0'); const s=String(Math.floor((d%60000)/1000)).padStart(2,'0'); D.countdown.textContent=`Próximo candle em: ${m}:${s}`;},1000); }

  // ----- WEBSOCKET -----
  function connectWS(){ if(state.ws&&state.ws.readyState===WebSocket.OPEN) return; state.ws=new WebSocket(cfg.wsUrl);
    state.ws.onopen=()=>{ log('OBS','WebSocket conectado'); startCountdown(); };
    state.ws.onmessage=ev=>{
      if(!state.isRunning) return;
      // ... atualização de candles e indicadores (igual antes) ...

      // DETECT SIGNALS
      const signals = state.indicators; // placeholder: insira lógica de sinal
      const newSignal = /* lógica que define 'COMPRA' ou 'VENDA' ou null */ null;
      if(newSignal && newSignal !== state.lastSignal) {
        state.lastSignal = newSignal;
        log('OBS', `Sinal detectado: ${newSignal}`);
        notifyDiscord(`SINAL ${newSignal}`);
      }

      renderChart();
      updateUI();
    };
    state.ws.onerror=e=>log('ERRO', e.message||e);
    state.ws.onclose=()=>log('OBS','WebSocket desconectado');
  }
  function disconnectWS(){ if(state.ws) state.ws.close(); clearInterval(state.countdownId); }

  // ----- CONTROL -----
  function startBot(){ state.capital=cfg.initialCapital; updateUI(); connectWS(); D.toggleBot.textContent='Desligar Simulador'; D.testBtn.disabled=false; D.discordBtn.disabled=false; D.toggleDiscord.disabled=false; log('OBS','Simulador ligado'); }
  function stopBot(){ disconnectWS(); D.toggleBot.textContent='Ligar Simulador'; log('OBS','Simulador desligado'); }
  D.toggleBot.addEventListener('click',()=>{ state.isRunning? stopBot(): startBot(); state.isRunning=!state.isRunning; });

  // ----- DISCORD TOGGLE -----
  D.toggleDiscord.addEventListener('click',()=>{ state.discordEnabled=!state.discordEnabled; D.toggleDiscord.textContent=state.discordEnabled?'Desativar Discord':'Ativar Notificações Discord'; log('OBS',`Discord ${state.discordEnabled?'ativado':'desativado'}`); });

  // ----- TEST BTN -----
  D.testBtn.addEventListener('click',testNotification);
  D.discordBtn.addEventListener('click',()=>notifyDiscord('Teste Discord'));

  // ----- INIT -----
  (async()=>{ try{ const data=await fetch(cfg.restUrl).then(r=>r.json()); data.forEach(c=>{ state.candles.times.push(new Date(c[0])); state.candles.open.push(+c[1]); state.candles.high.push(+c[2]); state.candles.low.push(+c[3]); state.candles.close.push(+c[4]); }); state.indicators={ sma5:SMA(state.candles.close,5), sma10:SMA(state.candles.close,10), rsi:RSI(state.candles.close,14), bb:BB(state.candles.close,20,2), macd:MACD(state.candles.close,12,26,9) }; renderChart(); runBacktest(); updateUI(); log('OBS','Dados iniciais carregados');}catch(err){ log('ERRO',`Init falhou: ${err.message}`);} })();
})();
