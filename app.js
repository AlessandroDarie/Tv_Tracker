// Motore di Debounce: blocca le raffiche di chiamate API
function debounce(func, delay) {
    let timeoutId;
    return function (...args) {
        // Se l'utente preme un tasto, cancella il timer precedente
        clearTimeout(timeoutId);
        // Fa partire un nuovo timer
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

// 1. Inizializzazione dei silos asincroni tramite localForage
const UserLibrary = localforage.createInstance({
    name: "TVTracker",
    storeName: "user_library",
    description: "Database utente: ID serie, stato, tracking episodi"
});

const TmdbCache = localforage.createInstance({
    name: "TVTracker",
    storeName: "tmdb_cache",
    description: "Buffer dati: Oggetti JSON immensi scaricati da TMDB"
});

// 2. Motore di test e validazione dell'infrastruttura
async function testDownloadAndCache(tvId) {
    try {
        console.log(`[SYS] Richiesta dati a TMDB per ID: ${tvId}...`);
        
        const url = TMDB_CONFIG.buildTvUrl(tvId);
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Errore HTTP ${response.status}: Verifica la validità della tua API Key o la tua connessione.`);
        }
        
        const data = await response.json();
        
        // Applicazione della marca temporale per logica di cache futura
        data.last_updated = Date.now();
        
        // Scrittura asincrona. Se fallisce qui, il browser ha esaurito lo spazio o bloccato IndexedDB
        await TmdbCache.setItem(String(tvId), data);
        console.log(`[OK] Serie "${data.name}" salvata con successo in TmdbCache!`);
        
        // Lettura asincrona per confermare l'integrità del dato scritto
        const savedData = await TmdbCache.getItem(String(tvId));
        console.log("[DATA] Estrazione dal database locale completata:", savedData);
        
    } catch (error) {
        console.error("[CRITICO] Fallimento architettura dati:", error);
    }
}



async function addSeriesToLibraryFromSearch(tvId) {
    if (!tvId) return;

    try {
        console.log(`[SYS] Inizio procedura di tracciamento per ID: ${tvId}...`);

        // 2. Controllo duplicati (Interrogazione del database asincrono)
        const existingEntry = await UserLibrary.getItem(String(tvId));
        if (existingEntry) {
            console.warn(`[AVVISO] La serie con ID ${tvId} è già presente nella tua libreria.`);
            return; // Blocca l'esecuzione, evitiamo sovrascritture accidentali
        }

        // 3. Scaricamento dati freschi da TMDB
        const url = TMDB_CONFIG.buildTvUrl(tvId);
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Serie non trovata o errore di rete (Status: ${response.status})`);
        }
        
        const tmdbData = await response.json();

        // 4. Scrittura nel Silos Pesante (TmdbCache)
        tmdbData.last_updated = Date.now();
        await TmdbCache.setItem(String(tvId), tmdbData);

        // 5. Scrittura nel Silos Leggero (UserLibrary) con il modello ottimizzato
        const userSeriesModel = {
            id: tvId,
            status: "watching",
            added_at: Date.now(),
            watched_count: 0,
            progress: {} // La Mappa vuota (Complessità O(1)) pronta per gli episodi
        };
        
        await UserLibrary.setItem(String(tvId), userSeriesModel);

        console.log(`[SUCCESSO] "${tmdbData.name}" aggiunta alla libreria utente!`);
        
        // Pulizia corretta della UI
        document.getElementById('search-input').value = '';
        document.getElementById('search-results').innerHTML = '';

        // AVVIO DEL PROCESSO IN BACKGROUND
        // Aggiorna visivamente il cruscotto
        renderLibrary();
        // Nota cruciale: NON c'è il comando "await" qui davanti. 
        // JavaScript lancerà questa funzione e andrà avanti, sbloccando l'interfaccia.
        if (tmdbData.seasons && tmdbData.seasons.length > 0) {
            backgroundSeasonSync(tvId, tmdbData.seasons);
        }

    } catch (error) {
        console.error("[CRITICO] Fallimento durante l'aggiunta:", error);
    }
}

async function searchSeries() {
    const inputElement = document.getElementById('search-input');
    const resultsContainer = document.getElementById('search-results');
    const query = inputElement.value.trim();

    if (!query) return;

    try {
        resultsContainer.innerHTML = '<span style="color: var(--text-muted);">Ricerca in corso...</span>';
        const url = TMDB_CONFIG.buildSearchUrl(query);
        const response = await fetch(url);
        if (!response.ok) throw new Error("Errore durante la ricerca.");
        
        const data = await response.json();
        resultsContainer.innerHTML = '';

        if (data.results.length === 0) {
            resultsContainer.innerHTML = '<span style="color: var(--danger);">Nessun risultato trovato.</span>';
            return;
        }

        data.results.slice(0, 5).forEach(series => {
            const year = series.first_air_date ? series.first_air_date.substring(0, 4) : 'N/A';
            const item = document.createElement('div');
            item.className = 'card';
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.alignItems = 'center';
            item.style.padding = '1rem';
            item.style.marginBottom = '0';
            
            item.innerHTML = `
                <div>
                    <strong>${series.name}</strong> <span style="color: var(--text-muted); font-size: 0.9em;">(${year})</span>
                </div>
                <button class="btn btn-success btn-small" onclick="addSeriesToLibraryFromSearch(${series.id})">Traccia</button>
            `;
            resultsContainer.appendChild(item);
        });
    } catch (error) {
        console.error(error);
        resultsContainer.innerHTML = '<span style="color: var(--danger);">Errore di connessione o API.</span>';
    }
}

// Utilità per creare pause artificiali nell'esecuzione (Throttling)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Motore asincrono in background per il download intensivo
async function backgroundSeasonSync(tvId, seasonsList) {
    console.log(`[SYNC] Avvio download in background per ${seasonsList.length} stagioni (ID: ${tvId})...`);
    
    // Recuperiamo il pacchetto dati principale dal silos pesante
    let tmdbData = await TmdbCache.getItem(String(tvId));
    if (!tmdbData) return;

    // Prepariamo un contenitore per le stagioni dettagliate
    tmdbData.detailed_seasons = {};

    for (const season of seasonsList) {
        // Evita di scaricare le stagioni "Speciali" (solitamente season_number 0) se non ti interessano
        if (season.season_number === 0) continue; 

        try {
            const seasonUrl = `${TMDB_CONFIG.BASE_URL}/tv/${tvId}/season/${season.season_number}?api_key=${TMDB_CONFIG.API_KEY}&language=it-IT`;
            const response = await fetch(seasonUrl);
            
            if (response.ok) {
                const seasonData = await response.json();
                // Salviamo i dati della stagione dentro l'oggetto principale
                tmdbData.detailed_seasons[season.season_number] = seasonData;
                console.log(`[SYNC] Stagione ${season.season_number} scaricata.`);
            } else {
                console.warn(`[SYNC] Errore download Stagione ${season.season_number}`);
            }

            // PAUSA STRATEGICA: Aspettiamo 300 millisecondi prima della prossima chiamata
            // Questo impedisce a TMDB di bloccare il nostro IP per "Too Many Requests"
            await sleep(300); 

        } catch (error) {
            console.error(`[SYNC] Fallimento critico su stagione ${season.season_number}:`, error);
        }
    }

    // Aggiorniamo il database pesante con l'oggetto completo di tutti gli episodi
    await TmdbCache.setItem(String(tvId), tmdbData);
    console.log(`[SYNC COMPLETO] Tutti i dati per l'ID ${tvId} sono ora offline-ready.`);

    // IL DISPACCIO: Spara un evento globale personalizzato nel browser
    document.dispatchEvent(new CustomEvent('seasonSyncCompleted', { 
        detail: { syncedTvId: String(tvId) } 
    }));
}


// Renderizza il cruscotto principale dell'utente
async function renderLibrary() {
    const grid = document.getElementById('library-grid');
    grid.innerHTML = '<span style="color: var(--text-muted); grid-column: 1 / -1;">Caricamento libreria...</span>';

    try {
        const keys = await UserLibrary.keys();
        if (keys.length === 0) {
            grid.innerHTML = '<span style="color: var(--text-muted); grid-column: 1 / -1; text-align: center; padding: 2rem 0;">La tua libreria è vuota. Cerca una serie per iniziare.</span>';
            return;
        }
        grid.innerHTML = '';

        for (const key of keys) {
            const userSeries = await UserLibrary.getItem(key);
            let tmdbData = await TmdbCache.getItem(key);

            if (!tmdbData) {
                // Logica di reidratazione invariata
                try {
                    const url = TMDB_CONFIG.buildTvUrl(key);
                    const res = await fetch(url);
                    if (!res.ok) throw new Error("API irraggiungibile");
                    tmdbData = await res.json();
                    tmdbData.last_updated = Date.now();
                    await TmdbCache.setItem(key, tmdbData);
                    if (tmdbData.seasons && tmdbData.seasons.length > 0) backgroundSeasonSync(key, tmdbData.seasons);
                } catch (e) {
                    continue; 
                }
            }

            const posterUrl = tmdbData.poster_path ? `${TMDB_CONFIG.IMAGE_BASE_URL}${tmdbData.poster_path}` : 'https://via.placeholder.com/500x750?text=No+Image';
            const card = document.createElement('div');
            card.className = 'series-card';
            card.onclick = () => {
                openDetailView(userSeries.id);
                switchTab('detail'); // Naviga automaticamente alla scheda dettaglio
            };

            card.innerHTML = `
                <img src="${posterUrl}" alt="${tmdbData.name}">
                <div class="series-card-content">
                    <span class="series-title" title="${tmdbData.name}">${tmdbData.name}</span>
                    <span class="series-status">Stato: ${userSeries.status}</span>
                </div>
            `;
            grid.appendChild(card);
        }
    } catch (error) {
        console.error(error);
        grid.innerHTML = '<span style="color: var(--danger); grid-column: 1 / -1;">Errore database locale.</span>';
    }
}


// Motore di rendering degli episodi
async function openDetailView(tvId) {
    window.currentOpenTvId = String(tvId);
    const detailContent = document.getElementById('detail-content');
    detailContent.innerHTML = '<span style="color: var(--text-muted);">Estrazione dati...</span>';

    try {
        const userSeries = await UserLibrary.getItem(String(tvId));
        const tmdbData = await TmdbCache.getItem(String(tvId));
        if (!tmdbData || !userSeries) throw new Error("Dati mancanti.");

        // Header della Serie Brutalista
        let html = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                <h2 style="margin: 0; text-transform: uppercase; font-weight: 900; letter-spacing: -0.5px; font-size: 1.8rem;">${tmdbData.name}</h2>
                <button class="btn btn-danger btn-small" onclick="removeSeries(${tvId})">Elimina</button>
            </div>
        `;
        
        if (!tmdbData.detailed_seasons || Object.keys(tmdbData.detailed_seasons).length === 0) {
            html += `<div class="card" style="border-color: var(--danger);"><p style="color: var(--danger); font-weight: bold; margin:0;">Sincronizzazione in corso... Attendi qualche secondo e riapri la scheda.</p></div>`;
            detailContent.innerHTML = html;
            return;
        }

        // Costruzione delle Stagioni stile SetFree
        for (const [seasonNum, seasonData] of Object.entries(tmdbData.detailed_seasons)) {
            const bodyId = `season-body-${tvId}-${seasonNum}`;
            const numEpisodes = seasonData.episodes ? seasonData.episodes.length : 0;
            
            html += `
                <div style="border: 1.5px solid var(--text); border-left: 8px solid var(--primary); background: var(--card-bg); margin-bottom: 1rem; border-radius: 0;">
                    
                    <!-- HEADER COMPATTO (Clickabile) -->
                    <div onclick="const b = document.getElementById('${bodyId}'); b.style.display = b.style.display === 'none' ? 'block' : 'none';" 
                         style="padding: 1.25rem; display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none;">
                        
                        <div>
                            <strong style="font-size: 1.2rem; text-transform: uppercase; display: block;">Stagione ${seasonNum}</strong>
                            <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 800; margin-top: 0.3rem;">
                                ${numEpisodes} EPISODI <span style="font-size: 0.7rem; font-weight: 400; opacity: 0.7;">(Clicca per espandere)</span>
                            </div>
                        </div>
                    </div>

                    <!-- LISTA EPISODI (Nascosta di default) -->
                    <div id="${bodyId}" style="display: none; border-top: 1.5px solid var(--text); padding: 0 1.25rem;">
            `;
            
            if (seasonData.episodes && seasonData.episodes.length > 0) {
                seasonData.episodes.forEach((ep, i) => {
                    const epKey = `S${String(seasonNum).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`;
                    const isWatched = userSeries.progress && userSeries.progress[epKey];
                    
                    // Stili reattivi per episodio visto/non visto
                    const titleClass = isWatched ? 'ep-title watched' : 'ep-title';
                    const titleStyle = isWatched ? 'color: var(--text-muted); text-decoration: line-through;' : 'color: var(--text);';
                    const btnClass = isWatched ? 'btn btn-success btn-small' : 'btn btn-outline btn-small';
                    const btnText = isWatched ? 'Visto' : 'Segna come visto';
                    
                    const isLast = i === seasonData.episodes.length - 1;
                    const borderBottom = isLast ? '' : 'border-bottom: 1px solid var(--border);';

                    html += `
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 1.25rem 0; ${borderBottom}">
                            <div style="padding-right: 1rem;">
                                <span id="title-${tvId}-${epKey}" class="${titleClass}" style="display: block; font-size: 1rem; font-weight: 700; ${titleStyle}">
                                    <span style="color: var(--text-muted); display: inline-block; width: 28px;">${ep.episode_number}.</span> 
                                    ${ep.name}
                                </span>
                            </div>
                            <button id="btn-${tvId}-${epKey}" class="${btnClass}" style="white-space: nowrap; flex-shrink: 0;" onclick="toggleEpisode(${tvId}, '${epKey}')">
                                ${btnText}
                            </button>
                        </div>
                    `;
                });
            } else {
                html += `<div style="padding: 1.25rem 0; color: var(--text-muted);">Nessun episodio trovato.</div>`;
            }
            
            html += `
                    </div>
                </div>
            `;
        }
        detailContent.innerHTML = html;

    } catch (error) {
        console.error(error);
        detailContent.innerHTML = '<span style="color: var(--danger);">Errore critico nella lettura della cache. Controlla la console.</span>';
    }
}

// Funzione chirurgica per lo stato dell'episodio (Nessun ricaricamento distruttivo)
async function toggleEpisode(tvId, epKey) {
    try {
        const userSeries = await UserLibrary.getItem(String(tvId));
        const tmdbData = await TmdbCache.getItem(String(tvId));
        
        // 1. TROVA IL MINUTAGGIO ESATTO DELL'EPISODIO
        let epRuntime = 45; // Fallback di sicurezza
        const match = epKey.match(/S(\d+)E(\d+)/);
        
        if (match && tmdbData && tmdbData.detailed_seasons) {
            const sNum = parseInt(match[1], 10);
            const eNum = parseInt(match[2], 10);
            const seasonData = tmdbData.detailed_seasons[sNum];
            
            if (seasonData && seasonData.episodes) {
                const epData = seasonData.episodes.find(e => e.episode_number === eNum);
                // TMDB fornisce 'runtime' sul singolo episodio se disponibile
                if (epData && epData.runtime) {
                    epRuntime = epData.runtime;
                } else if (tmdbData.episode_run_time && tmdbData.episode_run_time.length > 0) {
                    // Fallback sulla media della serie se l'episodio specifico non ha il dato
                    epRuntime = tmdbData.episode_run_time[0];
                }
            }
        }
        const isWatched = !!(userSeries.progress && userSeries.progress[epKey]);

        // 2. AGGIORNA I CONTATORI
        if (!isWatched) {
            // L'utente ha appena visto l'episodio
            userSeries.progress[epKey] = Date.now();
            userSeries.watched_count = (userSeries.watched_count || 0) + 1;
            userSeries.watched_minutes = (userSeries.watched_minutes || 0) + epRuntime;
        } else {
            // L'utente ha rimosso la spunta
            delete userSeries.progress[epKey];
            userSeries.watched_count = Math.max(0, (userSeries.watched_count || 0) - 1);
            userSeries.watched_minutes = Math.max(0, (userSeries.watched_minutes || 0) - epRuntime);
        }

        await UserLibrary.setItem(String(tvId), userSeries);
        
        // 2. Aggiornamento DOM Chirurgico con le nuove classi CSS
        const btn = document.getElementById(`btn-${tvId}-${epKey}`);
        const titleSpan = document.getElementById(`title-${tvId}-${epKey}`);
        
        if (btn && titleSpan) {
            btn.className = !isWatched ? 'btn btn-success btn-small' : 'btn btn-outline btn-small';
            btn.innerText = !isWatched ? 'Visto' : 'Segna come visto';
            titleSpan.className = !isWatched ? 'ep-title watched' : 'ep-title';
            titleSpan.style.color = !isWatched ? 'var(--text-muted)' : 'var(--text)';
            titleSpan.style.textDecoration = !isWatched ? 'line-through' : 'none';
        }
    } catch (error) {
        console.error("[CRITICO] Fallimento salvataggio progresso:", error);
    }
}

// ==========================================
// MOTORE DI BACKUP E RIPRISTINO (Silos Leggero)
// ==========================================

async function exportData() {
    try {
        const keys = await UserLibrary.keys();
        const exportObj = {};
        
        for (const key of keys) {
            exportObj[key] = await UserLibrary.getItem(key);
        }
        
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportObj));
        const downloadAnchorNode = document.createElement('a');
        
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", `setfree_tv_backup_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(downloadAnchorNode); // Richiesto per Firefox
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        
        alert("Backup esportato con successo. Conserva questo file al sicuro.");
    } catch (error) {
        console.error("Errore durante l'esportazione:", error);
        alert("Fallimento critico durante la creazione del backup.");
    }
}

async function importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const importedData = JSON.parse(e.target.result);
            
            // Validazione basilare del formato
            if (typeof importedData !== 'object' || importedData === null) throw new Error("Formato non valido");

            // Sovrascrittura massiva del database utente
            for (const [key, value] of Object.entries(importedData)) {
                await UserLibrary.setItem(key, value);
                
                // Opzionale: Se i dati TMDB mancano in cache, andrebbero riscaricati, 
                // ma per ora forziamo il salvataggio logico.
            }

            alert("Backup ripristinato con successo! Ricarica la pagina o il cruscotto.");
            event.target.value = ''; // Resetta l'input file
            renderLibrary(); // Aggiorna la vista

        } catch (error) {
            console.error("Errore durante l'importazione:", error);
            alert("Il file selezionato non è un backup valido.");
        }
    };
    
    reader.readAsText(file);
}

// ==========================================
// MOTORE UI E NAVIGAZIONE
// ==========================================

// Inizializzazione Tema
const currentTheme = localStorage.getItem('tvTheme') || 'dark';
document.documentElement.setAttribute('data-theme', currentTheme);

function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('tvTheme', newTheme);
    updateSettingsUI();
}

// Navigazione a Schede
function switchTab(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewId}`).classList.add('active');
    
    document.querySelectorAll('.nav-links button').forEach(b => b.classList.remove('active'));
    const targetNav = document.getElementById(`nav-${viewId}`);
    if (targetNav) targetNav.classList.add('active');

    // Trigger selettivo del motore di rendering
    if (viewId === 'library') renderLibrary();
    if (viewId === 'home') renderHome();
    if (viewId === 'stats') renderStats();
    
    window.scrollTo(0, 0);
}

// Modale Impostazioni
function openSettings() {
    updateSettingsUI();
    document.getElementById('modal-settings').classList.add('active');
}

function closeSettings(event, force = false) {
    if (force || event.target.id === 'modal-settings') {
        document.getElementById('modal-settings').classList.remove('active');
    }
}

function updateSettingsUI() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const btn = document.getElementById('btn-toggle-theme');
    if (btn) {
        btn.innerText = isDark ? 'ON' : 'OFF';
        btn.style.borderColor = isDark ? 'var(--text)' : 'var(--border)';
        btn.style.color = isDark ? 'var(--card-bg)' : 'var(--text-muted)';
        btn.style.background = isDark ? 'var(--text)' : 'transparent';
    }
}

// ==========================================
// CRUSCOTTO (HOME) E STATISTICHE
// ==========================================

async function renderHome() {
    const container = document.getElementById('home-content');
    container.innerHTML = '<span style="color: var(--text-muted);">Lettura progressi...</span>';
    
    try {
        const keys = await UserLibrary.keys();
        if(keys.length === 0) {
            container.innerHTML = `
                <p style="color: var(--text-muted); margin-bottom: 1rem;">Nessuna serie nella tua libreria.</p>
                <button class="btn btn-success" onclick="switchTab('search')">Cerca una serie</button>
            `;
            return;
        }
        
        // Algoritmo per trovare la serie con l'interazione più recente
        let lastWatchedSeries = null;
        let lastWatchedTime = 0;
        
        for (const key of keys) {
            const userSeries = await UserLibrary.getItem(key);
            if(userSeries.progress) {
                for(const ep in userSeries.progress) {
                    if(userSeries.progress[ep] > lastWatchedTime) {
                        lastWatchedTime = userSeries.progress[ep];
                        lastWatchedSeries = userSeries;
                    }
                }
            }
        }
        
        if(!lastWatchedSeries) {
            container.innerHTML = `
                <p style="color: var(--text-muted); margin-bottom: 1rem;">Hai aggiunto serie alla libreria, ma non hai ancora segnato nessun episodio come visto.</p>
                <button class="btn" onclick="switchTab('library')">Apri la Libreria</button>
            `;
            return;
        }
        
        const tmdbData = await TmdbCache.getItem(String(lastWatchedSeries.id));
        const dateStr = new Date(lastWatchedTime).toLocaleDateString('it-IT');
        
        container.innerHTML = `
            <p style="font-size: 0.75rem; font-weight: 800; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.5rem; letter-spacing: 0.5px;">Visto di recente (${dateStr})</p>
            <div style="border: 1.5px solid var(--text); border-left: 8px solid var(--primary); padding: 1.25rem; background: var(--input-bg); display: flex; justify-content: space-between; align-items: center;">
                <strong style="font-size: 1.1rem; text-transform: uppercase; line-height: 1.2;">${tmdbData ? tmdbData.name : 'Dati mancanti'}</strong>
                <button class="btn btn-success btn-small" onclick="openDetailView(${lastWatchedSeries.id}); switchTab('detail');">Continua</button>
            </div>
        `;
    } catch (e) {
        console.error("[CRITICO] Fallimento rendering Home:", e);
        container.innerHTML = '<span style="color: var(--danger);">Errore nel caricamento del cruscotto.</span>';
    }
}

// ==========================================
// MOTORE DI CONFERMA ASINCRONO
// ==========================================
function customConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-confirm');
        const msgEl = document.getElementById('modal-confirm-message');
        const btnOk = document.getElementById('btn-confirm-ok');
        const btnCancel = document.getElementById('btn-confirm-cancel');

        // Imposta il messaggio e mostra la modale
        msgEl.innerText = message;
        modal.classList.add('active');

        // Funzione di pulizia per rimuovere i listener dopo il click
        const cleanup = () => {
            modal.classList.remove('active');
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
        };

        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
    });
}

async function renderStats() {
    const container = document.getElementById('stats-content');
    container.innerHTML = '<span style="color: var(--text-muted);">Calcolo metriche in corso...</span>';
    
    try {
        const keys = await UserLibrary.keys();
        let totalSeries = keys.length;
        let totalEpisodes = 0;
        let totalMinutes = 0;
        
        for (const key of keys) {
            const userSeries = await UserLibrary.getItem(key);
            
            const epCount = userSeries.watched_count || 0;
            totalEpisodes += epCount;
            
            // Se esiste il nuovo contatore esatto, usalo.
            if (userSeries.watched_minutes !== undefined) {
                totalMinutes += userSeries.watched_minutes;
            } else {
                // RETROCOMPATIBILITÀ
                const tmdbData = await TmdbCache.getItem(key);
                let runtime = 45; 
                if(tmdbData && tmdbData.episode_run_time && tmdbData.episode_run_time.length > 0) {
                    runtime = tmdbData.episode_run_time[0];
                }
                totalMinutes += (epCount * runtime);
            }
        }
        
        // Nuova logica di calcolo ad alta precisione
        const hours = Math.floor(totalMinutes / 60);
        const remainingMinutes = totalMinutes % 60;
        const days = (totalMinutes / 1440).toFixed(1); // 1440 minuti in un giorno esatto
        
        container.innerHTML = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
                <div style="border: 1.5px solid var(--text); padding: 1.25rem; background: var(--input-bg);">
                    <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; font-weight: 800;">Serie Tracciate</div>
                    <div style="font-size: 2rem; font-weight: 900; line-height: 1.1; margin-top: 0.2rem;">${totalSeries}</div>
                </div>
                <div style="border: 1.5px solid var(--text); padding: 1.25rem; background: var(--input-bg);">
                    <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; font-weight: 800;">Episodi Visti</div>
                    <div style="font-size: 2rem; font-weight: 900; line-height: 1.1; margin-top: 0.2rem;">${totalEpisodes}</div>
                </div>
            </div>
            
            <div style="border: 1.5px solid var(--text); padding: 1.25rem; background: var(--card-bg);">
                <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; font-weight: 800;">Tempo Vitale Consumato</div>
                <div style="display: flex; align-items: baseline; gap: 0.2rem; margin-top: 0.5rem;">
                    <span style="font-size: 2.5rem; font-weight: 900; line-height: 1; color: var(--text);">${hours}</span>
                    <span style="color: var(--text-muted); font-weight: 700; font-size: 1.2rem; margin-right: 0.5rem;">h</span>
                    <span style="font-size: 2.5rem; font-weight: 900; line-height: 1; color: var(--text);">${remainingMinutes}</span>
                    <span style="color: var(--text-muted); font-weight: 700; font-size: 1.2rem;">m</span>
                </div>
                <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.5rem; font-weight: 600;">Equivalgono a circa <strong style="color: var(--text);">${days} giorni</strong> ininterrotti.</p>
            </div>
        `;
    } catch (e) {
        console.error("[CRITICO] Fallimento rendering Stats:", e);
        container.innerHTML = '<span style="color: var(--danger);">Impossibile calcolare le statistiche.</span>';
    }
}

// Distruzione totale della serie da entrambi i database
async function removeSeries(tvId) {
    // Sostituiamo il confirm di sistema con la modale brutalista
    const confirmation = await customConfirm("Vuoi davvero eliminare questa serie e tutti i suoi progressi dalla tua libreria?");
    if (!confirmation) return;

    try {
        await UserLibrary.removeItem(String(tvId));
        await TmdbCache.removeItem(String(tvId));
        
        console.log(`[SYS] Serie ${tvId} annientata con successo.`);
        
        // Chiude la vista dettaglio forzando il ritorno alla libreria
        switchTab('library');
    } catch (error) {
        console.error("[CRITICO] Fallimento durante l'eliminazione:", error);
        alert("Errore critico durante la rimozione dal database.");
    }
}

// Ascoltatore di sistema per l'aggiornamento reattivo dell'interfaccia
document.addEventListener('seasonSyncCompleted', (event) => {
    const { syncedTvId } = event.detail;
    const detailView = document.getElementById('detail-view');

    // Se la vista dettaglio è aperta sullo schermo E l'ID che ha appena finito di 
    // scaricare è esattamente quello che l'utente sta guardando, forza l'aggiornamento
    if (detailView.style.display === 'block' && window.currentOpenTvId === syncedTvId) {
        console.log(`[REATTIVITÀ] Sincronizzazione di ${syncedTvId} completata. Ricarico la UI invisibilmente.`);
        openDetailView(syncedTvId);
    }
});

// Registrazione del Service Worker per la modalità Offline vera
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('[SYS] Service Worker registrato con successo.', reg.scope))
            .catch(err => console.error('[CRITICO] Registrazione Service Worker fallita:', err));
    });
}

// Inizializzazione dell'app al caricamento
switchTab('home');