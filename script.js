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
    indicators: {}, signals: [], trades: [], position: null,
    capital: cfg.initialCapital,
    ws: null,
    countdownId: null,
    isRunning: false,
    discordEnabled: false
  };

  // ----- REFERÊNCIAS DOM -----
  const D = {
    chart:          document.getElementById('chart'),
    countdown:      document.getElementById('countdown'),
    toggleBot:      document.getElementById('btnToggleBot'),
    testBtn:        document.getElementById('btnTest'),
    discordBtn:     document.getElementById('btnDiscord'),
    toggleDiscord:  document.getElementById('btnToggleDiscord'),
    webhookInput:   document.getElementById('discordWebhook'),
    backtest:       document.getElementById('backtestResult'),
    signalList:     document.getElementById('signalList'),
    simBody:        document.getElementById('simulationBody'),
    entryInfo:      document.getElementById('entryInfo'),
    tpInfo:         document.getElementById('takeProfitSuggestion'),
    slInfo:         document.getElementById('stopSuggestion'),
    rrInfo:         document.getElementById('riskReward'),
    capInfo:        document.getElementById('currentCapitalDisplay'),
    logOutput:      document.getElementById('logOutput')
  };

  // ----- LOG -----
  function log(type, msg) {
    const time = new Date().toLocaleTimeString();
    D.logOutput.textContent += `\n[${time}] ${type}: ${msg}`;
    D.logOutput.scrollTop = D.logOutput.scrollHeight;
  }

  // ----- NOTIFICAÇÕES -----
  function testNotification() {
    if (Notification.permission !== 'granted') {
      Notification.requestPermission().then(p => p === 'granted' && new Notification('Teste', { body: 'Notificação funciona!' }));
    } else {
      new Notification('Teste', { body: 'Notificação funciona!' });
    }
  }

  async function notifyDiscord(msg) {
    if (!state.discordEnabled) return;
    const webhook = D.webhookInput.value.trim();
    if (!webhook) { log('ERRO', 'Webhook Discord não configurado'); return; }
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: msg })
      });
      if (res.ok) log('OBS', 'Discord: mensagem enviada');
      else log('ERRO', `Discord status ${res.status}`);
    } catch (err) {
      log('ERRO', `Discord: ${err.message}`);
    }
  }

  // ----- INDICADORES -----
  function SMA(arr,p) { return arr.map((_,i,a) => i<p-1? null : a.slice(i-p+1,i+1).reduce((s,v)=>s+v,0)/p); }
  function RSI(arr,p) {
    const g=[], l=[];
    for(let i=1;i<arr.length;i++){ const d=arr[i]-arr[i-1]; g.push(Math.max(d,0)); l.push(Math.max(-d,0)); }
    const out = Array(arr.length).fill(null);
    if(g.length<p) return out;
    let ag = g.slice(0,p).reduce((s,v)=>s+v,0)/p;
    let al = l.slice(0,p).reduce((s,v)=>s+v,0)/p;
    out[p] = al===0?100:100-(100/(1+ag/al));
    for(let i=p+1;i<arr.length;i++){ ag=(ag*(p-1)+g[i-1])/p; al=(al*(p-1)+l[i-1])/p; out[i] = al===0?100:100-(100/(1+ag/al)); }
    return out;
  }
  function BB(arr,p,k) {
    const up=[], md=[], dn=[];
    for(let i=0;i<arr.length;i++){ if(i<p-1){ up.push(null); md.push(null); dn.push(null); } else {
      const slice = arr.slice(i-p+1,i+1);
      const mean = slice.reduce((s,v)=>s+v,0)/p;
      const std  = Math.sqrt(slice.reduce((s,v)=>s+(v-mean)**2,0)/p);
      md.push(mean); up.push(mean + k*std); dn.push(mean - k*std);
    }}
    return { up, md, dn };
  }
  function EMA(arr,p) { const k=2/(p+1); return arr.map((v,i,a)=> i? v*k + a[i-1]*(1-k) : v ); }
  function MACD(arr,f,s,sg) { const ef=EMA(arr,f), es=EMA(arr,s); const line=ef.map((v,i)=>v-es[i]); return { line, signal: EMA(line,sg) }; }

  // ----- RENDER CHART -----
  let plot;
  function renderChart() {
    const c=state.candles, ind=state.indicators;
    const traces=[
      { x:c.times, open:c.open, high:c.high, low:c.low, close:c.close, type:'candlestick', name:'Candles' },
      { x:c.times, y:ind.sma5, mode:'lines', name:'SMA5' },
      { x:c.times, y:ind.sma10,mode:'lines', name:'SMA10' },
      { x:c.times, y:ind.bb.md,mode:'lines', name:'BB Mid' },
      { x:c.times, y:ind.bb.up,mode:'lines', name:'BB Up' },
      { x:c.times, y:ind.bb.dn,mode:'lines', name:'BB Dn' },
      { x:c.times, y:ind.macd.line, mode:'lines', name:'MACD', yaxis:'y2' },
      { x:c.times, y:ind.macd.signal, mode:'lines', name:'Signal', yaxis:'y2' }
    ];
    const layout={ margin:{t:30,r:30,b:60,l:60}, xaxis:{title:'Hora',rangeslider:{visible:false}}, yaxis:{title:'Preço'}, yaxis2:{overlaying:'y',side:'right',title:'MACD'}, showlegend:true };
    if(plot) Plotly.react(D.chart, traces, layout);
    else plot=Plotly.newPlot(D.chart, traces, layout, {responsive:true});
  }

  // ----- BACKTEST -----
  function runBacktest() {
    const c=state.candles.close, ind=state.indicators, out=[];
    for(let i=1;i<c.length;i++){ const p=i-1;
      if([ind.sma5[p],ind.sma10[p],ind.rsi[p],ind.bb.md[p],ind.bb.up[p],ind.bb.dn[p],ind.macd.line[p],ind.macd.signal[p]].some(v=>v===null)) continue;
      const price=c[p];
      if(ind.sma5[p]<=ind.sma10[p] && ind.rsi[p]<70 && price>ind.bb.md[p] && ind.macd.line[p]>ind.macd.signal[p] && ind.sma5[i]>ind.sma10[i]) out.push(`${state.candles.times[p].toLocaleString()}: COMPRA`);
      else if(ind.sma5[p]>=ind.sma10[p] && ind.rsi[p]>30 && price<ind.bb.md[p] && ind.macd.line[p]<ind.macd.signal[p] && ind.sma5[i]<ind.sma10[i]) out.push(`${state.candles.times[p].toLocaleString()}: VENDA`);
    }
    D.backtest.textContent = out.length? `Sinais 24h:\n${out.join('\n')}` : 'Nenhum sinal encontrado';
    log('OBS', 'Backtest concluído');
  }

  // ----- UPDATE UI -----
  function updateUI() {
    const pos=state.position;
    D.capInfo.textContent = `Capital Atual: $${state.capital.toFixed(2)}`;
    D.capInfo.className = `trade-info ${state.capital>cfg.initialCapital?'buy':state.capital<cfg.initialCapital?'sell':'neutral'}`;
    if(pos) {
      D.entryInfo.textContent = `Posição: ${pos.side} @ ${pos.entryPrice.toFixed(2)}`;
      D.entryInfo.className = `trade-info ${pos.side==='COMPRA'?'buy':'sell'}`;
      D.tpInfo.textContent = `Take Profit: ${pos.takeProfit.toFixed(2)}`;
      D.slInfo.textContent = `Stop Loss: ${pos.stopLoss.toFixed(2)}`;
    } else {
      D.entryInfo.textContent = 'Nenhuma posição simulada';
      D.entryInfo.className = 'trade-info neutral';
      D.tpInfo.textContent = 'Take Profit: -';
      D.slInfo.textContent = 'Stop Loss: -';
    }
    D.rrInfo.textContent = 'Risco/Recompensa: -';
  }

  // ----- COUNTDOWN -----
  function startCountdown() {
    clearInterval(state.countdownId);
    state.countdownId = setInterval(()=>{
      const now=Date.now(), pr=15*60e3;
      const next=Math.ceil(now/pr)*pr;
      const d=next-now;
      const m=String(Math.floor(d/60000)).padStart(2,'0');
      const s=String(Math.floor((d%60000)/1000)).padStart(2,'0');
      D.countdown.textContent = `Próximo candle em: ${m}:${s}`;
    },1000);
  }

  // ----- WEBSOCKET -----
  function connectWS() {
    if(state.ws && state.ws.readyState===WebSocket.OPEN) return;
    state.ws = new WebSocket(cfg.wsUrl);
    state.ws.onopen = () => { log('OBS','WebSocket conectado'); startCountdown(); };
    state.ws.onmessage = ev => {
      if(!state.isRunning) return;
      const k = JSON.parse(ev.data).k;
      const t = new Date(k.t).getTime();
      const closePrice = +k.c;
      // Atualiza arrays
      if(k.x) { // finalizado
        if(state.candles.times.at(-1).getTime() === t) {
          ['times','open','high','low','close'].forEach(key => state.candles[key].pop());
        }
        state.candles.times.push(new Date(t));
        state.candles.open.push(+k.o);
        state.candles.high.push(+k.h);
        state.candles.low.push(+k.l);
        state.candles.close.push(closePrice);
      } else { // em formação
        const lastT = state.candles.times.at(-1)?.getTime();
        if(lastT !== t) {
          ['times','open','high','low','close'].forEach((key,i) => {
            const vals = [new Date(t), +k.o, +k.h, +k.l, +k.c];
            state.candles[key].push(vals[i]);
          });
        } else {
          state.candles.high.at(-1)  = Math.max(state.candles.high.at(-1),  +k.h);
          state.candles.low.at(-1)   = Math.min(state.candles.low.at(-1),   +k.l);
          state.candles.open.at(-1)  = +k.o;
          state.candles.close.at(-1) = closePrice;
        }
      }
      // trim
      ['times','open','high','low','close'].forEach(key=>{ while(state.candles[key].length>cfg.maxCandles) state.candles[key].shift(); });
      // recalcula
      state.indicators = {
        sma5:  SMA(state.candles.close,5),
        sma10: SMA(state.candles.close,10),
        rsi:   RSI(state.candles.close,14),
        bb:    BB(state.candles.close,20,2),
        macd:  MACD(state.candles.close,12,26,9)
      };
      renderChart(); runBacktest(); updateUI(); notifyDiscord(`SINAL ${state.position?.side}`);
    };
    state.ws.onerror = e => log('ERRO', e.message||e);
    state.ws.onclose = () => log('OBS','WebSocket desconectado');
  }

  function disconnectWS() {
    if(state.ws) state.ws.close();
    clearInterval(state.countdownId);
  }

  // ----- CONTROLE -----
  function startBot() {
    state.capital = cfg.initialCapital;
    state.trades  = [];
    updateUI(); connectWS();
    D.toggleBot.textContent = 'Desligar Simulador';
    D.testBtn.disabled = false;
    D.discordBtn.disabled = false;
    D.toggleDiscord.disabled = false;
    log('OBS','Simulador ligado');
  }
  function stopBot() {
    disconnectWS();
    D.toggleBot.textContent = 'Ligar Simulador';
    log('OBS','Simulador desligado');
  }
  D.toggleBot.addEventListener('click', () => {
    state.isRunning ? stopBot() : startBot();
    state.isRunning = !state.isRunning;
  });

  D.toggleDiscord.addEventListener('click', () => {
    state.discordEnabled = !state.discordEnabled;
    D.toggleDiscord.textContent = state.discordEnabled ? 'Desativar Discord' : 'Ativar Notificações Discord';
    log('OBS', `Discord ${state.discordEnabled?'ativado':'desativado'}`);
  });

  D.testBtn.addEventListener('click', testNotification);
  D.discordBtn.addEventListener('click', () => notifyDiscord('Teste Discord'));

  // ----- INICIALIZAÇÃO -----
  (async () => {
    try {
      const data = await fetch(cfg.restUrl).then(r=>r.json());
      data.forEach(c => {
        state.candles.times.push(new Date(c[0]));
        state.candles.open.push(+c[1]);
        state.candles.high.push(+c[2]);
        state.candles.low.push(+c[3]);
        state.candles.close.push(+c[4]);
      });
      state.indicators = {
        sma5:  SMA(state.candles.close,5),
        sma10: SMA(state.candles.close,10),
        rsi:   RSI(state.candles.close,14),
        bb:    BB(state.candles.close,20,2),
        macd:  MACD(state.candles.close,12,26,9)
      };
      renderChart(); runBacktest(); updateUI();
      log('OBS','Dados iniciais carregados');
    } catch(err) {
      log('ERRO', `Init falhou: ${err.message}`);
    }
  })();
})();
