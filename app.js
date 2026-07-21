// ==========================================
// CONFIGURAZIONE E SETUP INIZIALE
// ==========================================

// Motore di Debounce: blocca le raffiche di chiamate API
function debounce(func, delay) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

// Inizializzazione dei silos asincroni tramite localForage
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

// Utilità per creare pause artificiali nell'esecuzione (Throttling)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// MOTORE DI RICERCA E AGGIUNTA
// ==========================================

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

        data.results.slice(0, 8).forEach(series => {
            const year = series.first_air_date ? series.first_air_date.substring(0, 4) : 'N/A';
            const item = document.createElement('div');
            item.className = 'card';
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.alignItems = 'center';
            item.style.padding = '1rem';
            item.style.marginBottom = '0';
            
            // Bottone "Apri" invece di "Traccia"
            item.innerHTML = `
                <div>
                    <strong>${series.name}</strong> <span style="color: var(--text-muted); font-size: 0.9em;">(${year})</span>
                </div>
                <button class="btn btn-outline btn-small" onclick="previewSeries(${series.id})">Apri</button>
            `;
            resultsContainer.appendChild(item);
        });
    } catch (error) {
        console.error(error);
        resultsContainer.innerHTML = '<span style="color: var(--danger);">Errore di connessione o API.</span>';
    }
}

// Apre l'anteprima velocemente caricando solo i dati principali
async function previewSeries(tvId) {
    const loader = document.getElementById('global-loader');
    loader.classList.add('active'); // Attiva blur e rotella

    try {
        let tmdbData = await TmdbCache.getItem(String(tvId));
        if (!tmdbData) {
            const url = TMDB_CONFIG.buildTvUrl(tvId);
            const response = await fetch(url);
            if (!response.ok) throw new Error("API irraggiungibile");
            tmdbData = await response.json();
            tmdbData.last_updated = Date.now();
            await TmdbCache.setItem(String(tvId), tmdbData);
        }
        
        openDetailView(tvId);
        switchTab('detail');
    } catch (error) {
        console.error(error);
        await customAlert("Errore durante il caricamento dell'anteprima.");
    } finally {
        loader.classList.remove('active'); // Spegne il loader in ogni caso
    }
}

// Converte un'anteprima in una serie tracciata e fa partire il download pesante
async function addToLibraryFromPreview(tvId) {
    try {
        const tmdbData = await TmdbCache.getItem(String(tvId));
        if (!tmdbData) return;

        const userSeriesModel = {
            id: tvId,
            status: "watching", // Stato di default: in corso
            added_at: Date.now(),
            watched_count: 0,
            watched_minutes: 0,
            progress: {},
            is_favorite: false
        };
        
        await UserLibrary.setItem(String(tvId), userSeriesModel);
        console.log(`[SUCCESSO] "${tmdbData.name}" inizializzata in libreria!`);
        
        // Risveglia il download asincrono in background
        if (tmdbData.seasons && tmdbData.seasons.length > 0) {
            backgroundSeasonSync(tvId, tmdbData.seasons);
        }

        // Ricarica la vista dettaglio (passerà automaticamente da Anteprima a Modalità Piena)
        openDetailView(tvId);
        
    } catch (error) {
        console.error("[CRITICO] Fallimento durante l'aggiunta:", error);
        await customAlert("Errore critico durante l'aggiunta della serie.");
    }
}

async function backgroundSeasonSync(tvId, seasonsList) {
    console.log(`[SYNC] Avvio download in background per ${seasonsList.length} stagioni (ID: ${tvId})...`);
    
    let tmdbData = await TmdbCache.getItem(String(tvId));
    if (!tmdbData) return;

    tmdbData.detailed_seasons = {};

    for (const season of seasonsList) {
        if (season.season_number === 0) continue; 

        try {
            const seasonUrl = `${TMDB_CONFIG.BASE_URL}/tv/${tvId}/season/${season.season_number}?api_key=${TMDB_CONFIG.API_KEY}&language=it-IT`;
            const response = await fetch(seasonUrl);
            
            if (response.ok) {
                const seasonData = await response.json();
                tmdbData.detailed_seasons[season.season_number] = seasonData;
                console.log(`[SYNC] Stagione ${season.season_number} scaricata.`);
            } else {
                console.warn(`[SYNC] Errore download Stagione ${season.season_number}`);
            }
            await sleep(300); 
        } catch (error) {
            console.error(`[SYNC] Fallimento critico su stagione ${season.season_number}:`, error);
        }
    }

    await TmdbCache.setItem(String(tvId), tmdbData);
    console.log(`[SYNC COMPLETO] Tutti i dati per l'ID ${tvId} sono ora offline-ready.`);

    document.dispatchEvent(new CustomEvent('seasonSyncCompleted', { 
        detail: { syncedTvId: String(tvId) } 
    }));
}

// ==========================================
// VISTE PRINCIPALI (HOME, LIBRERIA, STATS)
// ==========================================

async function renderHome() {
    const container = document.getElementById('home-content');
    container.innerHTML = '<span style="color: var(--text-muted);">Scansione database in corso...</span>';

    try {
        const keys = await UserLibrary.keys();
        if(keys.length === 0) {
            container.innerHTML = `
                <p style="color: var(--text-muted); margin-bottom: 1rem;">La tua dashboard è vuota. Nessuna serie tracciata.</p>
                <button class="btn btn-success" onclick="switchTab('search')">Cerca una serie</button>
            `;
            return;
        }

        let inProgressHTML = '';
        let activeSeriesCount = 0;

        for (const key of keys) {
            const userSeries = await UserLibrary.getItem(key);
            
            // Ignora se non iniziata
            if (!userSeries.progress || Object.keys(userSeries.progress).length === 0) continue;

            const tmdbData = await TmdbCache.getItem(key);
            if (!tmdbData || !tmdbData.detailed_seasons) continue;

            let nextEpisode = null;
            let epRuntime = 45;

            // Logica di ricerca lineare (Stagioni ed Episodi)
            const seasonNumbers = Object.keys(tmdbData.detailed_seasons).map(Number).sort((a,b) => a - b);
            
            for (const sNum of seasonNumbers) {
                const season = tmdbData.detailed_seasons[sNum];
                if (season.episodes) {
                    const episodes = [...season.episodes].sort((a,b) => a.episode_number - b.episode_number);
                    for (const ep of episodes) {
                        const epKey = `S${String(sNum).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`;
                        
                        if (!userSeries.progress[epKey]) {
                            nextEpisode = { key: epKey, name: ep.name };
                            epRuntime = ep.runtime || (tmdbData.episode_run_time && tmdbData.episode_run_time[0]) || 45;
                            break;
                        }
                    }
                }
                if (nextEpisode) break;
            }

            if (nextEpisode) {
                activeSeriesCount++;
                
                // Recupero dell'immagine di copertina
                const posterUrl = tmdbData.poster_path ? `${TMDB_CONFIG.IMAGE_BASE_URL}${tmdbData.poster_path}` : 'https://via.placeholder.com/150x225?text=No+Img';

                // Blocco UI ad alta densità
                inProgressHTML += `
                    <div style="display: flex; border: 1.5px solid var(--text); background: var(--input-bg); margin-bottom: 0.75rem; overflow: hidden; height: 110px;">
                        
                        <!-- Immagine di Copertina (Sinistra) -->
                        <img src="${posterUrl}" style="width: 75px; object-fit: cover; border-right: 1.5px solid var(--text);" alt="${tmdbData.name}">
                        
                        <!-- Contenuto Operativo (Destra) -->
                        <div style="flex: 1; padding: 0.6rem 0.75rem; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden;">
                            
                            <div>
                                <!-- Titolo e Codice Episodio -->
                                <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem;">
                                    <strong style="font-size: 0.95rem; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.1;">
                                        ${tmdbData.name}
                                    </strong>
                                    <span style="font-size: 0.7rem; font-weight: 900; color: var(--text-muted); flex-shrink: 0; background: var(--card-bg); padding: 0.1rem 0.3rem; border: 1px solid var(--border); border-radius: 3px;">
                                        ${nextEpisode.key}
                                    </span>
                                </div>
                                
                                <!-- Nome Episodio -->
                                <div style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 0.2rem;">
                                    ${nextEpisode.name}
                                </div>
                            </div>

                            <!-- Azioni Rapide -->
                            <div style="display: flex; gap: 0.5rem; margin-top: auto;">
                                <button class="btn btn-success" style="flex: 1; padding: 0.25rem; font-size: 0.8rem; font-weight: 800;" onclick="markNextEpisodeWatched('${key}', '${nextEpisode.key}', ${epRuntime})">
                                    VISTO
                                </button>
                                <button class="btn btn-outline" style="padding: 0.25rem 0.6rem;" onclick="openDetailView('${key}'); switchTab('detail');" title="Dettagli">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                                </button>
                            </div>
                        </div>
                    </div>
                `;
            }
        }

        if (activeSeriesCount === 0) {
            container.innerHTML = `
                <p style="color: var(--text-muted); margin-bottom: 1rem;">Nessuna serie attiva al momento. Le serie in corso appariranno qui.</p>
                <button class="btn" onclick="switchTab('library')">Sfoglia Libreria</button>
            `;
        } else {
            container.innerHTML = `
                <p style="font-size: 0.75rem; font-weight: 800; text-transform: uppercase; color: var(--text-muted); margin-bottom: 1rem; letter-spacing: 0.5px;">Da continuare</p>
                ${inProgressHTML}
            `;
        }

    } catch (e) {
        console.error("[CRITICO] Fallimento rendering Home:", e);
        container.innerHTML = '<span style="color: var(--danger);">Errore nel calcolo del cruscotto operativo.</span>';
    }
}

// Motore chirurgico per l'avanzamento rapido direttamente dalla Home
async function markNextEpisodeWatched(tvId, epKey, epRuntime) {
    try {
        const userSeries = await UserLibrary.getItem(String(tvId));
        if (!userSeries) return;

        // Inizializza l'oggetto progressi se corrotto
        if (!userSeries.progress) userSeries.progress = {};

        // Iniezione dei dati contabili
        userSeries.progress[epKey] = Date.now();
        userSeries.watched_count = (userSeries.watched_count || 0) + 1;
        userSeries.watched_minutes = (userSeries.watched_minutes || 0) + epRuntime;

        // Chiusura transazione
        await UserLibrary.setItem(String(tvId), userSeries);

        // Feedback in console e re-render istantaneo del cruscotto
        console.log(`[SYS] Progresso rapido: ${tvId} -> ${epKey}`);
        
        // Questo riavvia il calcolo della Home: l'episodio appena cliccato 
        // verrà ignorato e il sistema pescherà automaticamente quello dopo.
        renderHome();
        
    } catch (error) {
        console.error("[CRITICO] Fallimento operazione rapida:", error);
        await customAlert("Errore critico durante il salvataggio.");
    }
}

// Utilità per calcolare l'ultima interazione assoluta (per l'ordinamento)
function getLastInteraction(userSeries) {
    if (!userSeries.progress || Object.keys(userSeries.progress).length === 0) {
        return userSeries.added_at || 0; // Se non ha episodi visti, usa la data di aggiunta
    }
    return Math.max(...Object.values(userSeries.progress));
}

// Renderizza il cruscotto principale dell'utente con filtri e ordinamento
async function renderLibrary(currentFilter = 'watching') {
    const grid = document.getElementById('library-grid');
    const filterButtons = document.querySelectorAll('#library-filters button');
    
    // Aggiorna UI dei bottoni filtro
    filterButtons.forEach(btn => btn.classList.remove('active'));
    // Trova il bottone cliccato in base al parametro e impostalo attivo
    const activeBtnIndex = ['watching', 'planned', 'paused', 'completed', 'favorite'].indexOf(currentFilter);
    if(activeBtnIndex >= 0) filterButtons[activeBtnIndex].classList.add('active');

    grid.innerHTML = '<span style="color: var(--text-muted); grid-column: 1 / -1;">Estrazione e ordinamento dati...</span>';

    try {
        const keys = await UserLibrary.keys();
        if (keys.length === 0) {
            grid.innerHTML = '<span style="color: var(--text-muted); grid-column: 1 / -1; text-align: center; padding: 2rem 0;">La tua libreria è vuota. Cerca una serie per iniziare.</span>';
            return;
        }

        let seriesArray = [];

        // 1. Estrazione e arricchimento dati
        for (const key of keys) {
            const userSeries = await UserLibrary.getItem(key);
            let tmdbData = await TmdbCache.getItem(key);

            if (!tmdbData) {
                try {
                    const url = TMDB_CONFIG.buildTvUrl(key);
                    const res = await fetch(url);
                    if (!res.ok) throw new Error("API irraggiungibile");
                    tmdbData = await res.json();
                    tmdbData.last_updated = Date.now();
                    await TmdbCache.setItem(key, tmdbData);
                    if (tmdbData.seasons && tmdbData.seasons.length > 0) backgroundSeasonSync(key, tmdbData.seasons);
                } catch (e) { continue; }
            }
            
            // Garantiamo che status esista (retrocompatibilità)
            if (!userSeries.status) userSeries.status = 'watching';
            
            seriesArray.push({
                key: key,
                user: userSeries,
                tmdb: tmdbData,
                lastInteraction: getLastInteraction(userSeries)
            });
        }

        // 2. Ordinamento Spaziale (Dal più recente al meno recente)
        seriesArray.sort((a, b) => b.lastInteraction - a.lastInteraction);

        // 3. Filtraggio Logico
        let filteredSeries = seriesArray.filter(item => {
            const epsWatched = item.user.watched_count || 0;
            const status = item.user.status;
            
            switch (currentFilter) {
                case 'watching': return status === 'watching' && epsWatched > 0;
                case 'planned': return status === 'watching' && epsWatched === 0;
                case 'paused': return status === 'paused';
                case 'completed': return status === 'completed';
                case 'favorite': return item.user.is_favorite === true;
                default: return true;
            }
        });

        grid.innerHTML = '';

        if (filteredSeries.length === 0) {
            grid.innerHTML = `<span style="color: var(--text-muted); grid-column: 1 / -1; text-align: center; padding: 2rem 0;">Nessuna serie in questa categoria.</span>`;
            return;
        }

        // 4. Rendering
        for (const item of filteredSeries) {
            const posterUrl = item.tmdb.poster_path ? `${TMDB_CONFIG.IMAGE_BASE_URL}${item.tmdb.poster_path}` : 'https://via.placeholder.com/500x750?text=No+Image';
            
            // Etichetta visiva dello stato
            let statusLabel = '';
            let statusColor = 'var(--text-muted)';
            if (item.user.status === 'completed') { statusLabel = 'COMPLETATA'; statusColor = 'var(--success)'; }
            else if (item.user.status === 'paused') { statusLabel = 'IN PAUSA'; statusColor = 'var(--text)'; }
            else if (item.user.watched_count === 0) { statusLabel = 'DA VEDERE'; }
            else { statusLabel = 'IN CORSO'; statusColor = 'var(--primary)'; }

            // Cuore rosso se preferita
            const favBadge = item.user.is_favorite ? `<div style="position: absolute; top: 5px; right: 5px; background: var(--card-bg); border-radius: 50%; padding: 4px; border: 1px solid var(--danger); color: var(--danger); line-height: 0;"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg></div>` : '';

            const card = document.createElement('div');
            card.className = 'series-card';
            card.style.position = 'relative';
            card.onclick = () => {
                openDetailView(item.user.id);
                switchTab('detail'); 
            };

            card.innerHTML = `
                ${favBadge}
                <img src="${posterUrl}" alt="${item.tmdb.name}">
                <div class="series-card-content">
                    <span class="series-title" title="${item.tmdb.name}">${item.tmdb.name}</span>
                    <span class="series-status" style="color: ${statusColor};">${statusLabel}</span>
                </div>
            `;
            grid.appendChild(card);
        }
    } catch (error) {
        console.error(error);
        grid.innerHTML = '<span style="color: var(--danger); grid-column: 1 / -1;">Errore database locale.</span>';
    }
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
            
            if (userSeries.watched_minutes !== undefined) {
                totalMinutes += userSeries.watched_minutes;
            } else {
                const tmdbData = await TmdbCache.getItem(key);
                let runtime = 45; 
                if(tmdbData && tmdbData.episode_run_time && tmdbData.episode_run_time.length > 0) {
                    runtime = tmdbData.episode_run_time[0];
                }
                totalMinutes += (epCount * runtime);
            }
        }
        
        const hours = Math.floor(totalMinutes / 60);
        const remainingMinutes = totalMinutes % 60;
        const days = (totalMinutes / 1440).toFixed(1);
        
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

// ==========================================
// DETTAGLIO SERIE ED EPISODI
// ==========================================

async function openDetailView(tvId) {
    window.currentOpenTvId = String(tvId);
    const detailContent = document.getElementById('detail-content');
    detailContent.innerHTML = '<span style="color: var(--text-muted);">Estrazione dati...</span>';

    try {
        // userSeries potrebbe essere NULL se siamo in modalità anteprima
        const userSeries = await UserLibrary.getItem(String(tvId));
        const tmdbData = await TmdbCache.getItem(String(tvId));
        
        if (!tmdbData) throw new Error("Dati TMDB mancanti.");

        const isPreview = !userSeries; // Variabile di stato cruciale

        const bannerUrl = tmdbData.backdrop_path 
            ? `https://image.tmdb.org/t/p/w780${tmdbData.backdrop_path}` 
            : (tmdbData.poster_path ? `${TMDB_CONFIG.IMAGE_BASE_URL}${tmdbData.poster_path}` : '');

        let bannerHTML = '';
        if (bannerUrl) {
            bannerHTML = `<div style="width: 100%; height: 160px; border: 1.5px solid var(--text); background: url('${bannerUrl}') center/cover; margin-bottom: 1.5rem; display: block;"></div>`;
        }

        // 1. HEADER (Il tasto elimina scompare in anteprima)
        let html = `
            ${bannerHTML}
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; gap: 1rem;">
                <h2 style="margin: 0; text-transform: uppercase; font-weight: 900; letter-spacing: -0.5px; font-size: 1.8rem; line-height: 1.1;">${tmdbData.name}</h2>
                ${!isPreview ? `<button class="btn btn-danger btn-small" style="flex-shrink: 0;" onclick="removeSeries(${tvId})">Elimina</button>` : ''}
            </div>
            
            <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem; line-height: 1.5;">${tmdbData.overview || 'Nessuna sinossi disponibile.'}</p>
        `;
        
        if (isPreview) {
            // 2. MODALITÀ ANTEPRIMA: Niente plancia, solo bottone gigante
            html += `
                <div style="margin-bottom: 1.5rem; background: var(--input-bg); padding: 1.25rem; border: 1.5px solid var(--primary); text-align: center;">
                    <p style="margin-bottom: 1rem; color: var(--text-muted); font-weight: 700; font-size: 0.85rem; text-transform: uppercase;">Questa serie non è tracciata</p>
                    <button class="btn btn-success" style="width: 100%; font-size: 1.1rem; padding: 1rem; font-weight: 900;" onclick="addToLibraryFromPreview(${tvId})">AGGIUNGI ALLA LIBRERIA</button>
                </div>
            `;
        } else {
            // 3. MODALITÀ TRACCIATA: Plancia di controllo e rendering stagioni
            const isFav = userSeries.is_favorite === true;
            const favIconFill = isFav ? 'currentColor' : 'none';
            const favColor = isFav ? 'var(--danger)' : 'var(--text-muted)';
            const favBorder = isFav ? 'var(--danger)' : 'var(--border)';
            const currentStatus = userSeries.status || 'watching';

            html += `
                <div style="display: flex; gap: 0.5rem; margin-bottom: 1.5rem; background: var(--input-bg); padding: 0.75rem; border: 1.5px solid var(--text);">
                    <select id="status-select-${tvId}" onchange="changeSeriesStatus(${tvId}, this.value)" style="flex: 1; padding: 0.5rem; background: var(--card-bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; font-weight: 700; text-transform: uppercase; font-size: 0.8rem; outline: none;">
                        <option value="watching" ${currentStatus === 'watching' ? 'selected' : ''}>In Corso / Da Vedere</option>
                        <option value="paused" ${currentStatus === 'paused' ? 'selected' : ''}>In Pausa</option>
                        <option value="completed" ${currentStatus === 'completed' ? 'selected' : ''}>Completata</option>
                    </select>
                    
                    <button onclick="toggleFavorite(${tvId})" class="btn btn-outline" style="padding: 0.5rem 1rem; color: ${favColor}; border-color: ${favBorder};">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="${favIconFill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                    </button>
                </div>
            `;

            if (!tmdbData.detailed_seasons || Object.keys(tmdbData.detailed_seasons).length === 0) {
                html += `<div class="card" style="border-color: var(--danger);"><p style="color: var(--danger); font-weight: bold; margin:0;">Sincronizzazione in corso... Attendi qualche secondo e riapri la scheda.</p></div>`;
            } else {
                for (const [seasonNum, seasonData] of Object.entries(tmdbData.detailed_seasons)) {
                    const bodyId = `season-body-${tvId}-${seasonNum}`;
                    const numEpisodes = seasonData.episodes ? seasonData.episodes.length : 0;
                    
                    html += `
                        <div style="border: 1.5px solid var(--text); border-left: 8px solid var(--primary); background: var(--card-bg); margin-bottom: 1rem; border-radius: 0;">
                            
                            <div onclick="const b = document.getElementById('${bodyId}'); b.style.display = b.style.display === 'none' ? 'block' : 'none';" 
                                 style="padding: 1.25rem; display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none;">
                                
                                <div>
                                    <strong style="font-size: 1.2rem; text-transform: uppercase; display: block;">Stagione ${seasonNum}</strong>
                                    <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 800; margin-top: 0.3rem;">
                                        ${numEpisodes} EPISODI <span style="font-size: 0.7rem; font-weight: 400; opacity: 0.7;">(Clicca per espandere)</span>
                                    </div>
                                </div>
                            </div>

                            <div id="${bodyId}" style="display: none; border-top: 1.5px solid var(--text); padding: 0 1.25rem;">
                    `;
                    
                    if (seasonData.episodes && seasonData.episodes.length > 0) {
                        seasonData.episodes.forEach((ep, i) => {
                            const epKey = `S${String(seasonNum).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`;
                            const isWatched = userSeries.progress && userSeries.progress[epKey];
                            
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
            }
        }
        detailContent.innerHTML = html;

    } catch (error) {
        console.error(error);
        detailContent.innerHTML = '<span style="color: var(--danger);">Errore critico nella lettura della cache. Controlla la console.</span>';
    }
}

async function toggleEpisode(tvId, epKey) {
    try {
        const userSeries = await UserLibrary.getItem(String(tvId));
        const tmdbData = await TmdbCache.getItem(String(tvId));
        
        let epRuntime = 45; 
        const match = epKey.match(/S(\d+)E(\d+)/);
        
        if (match && tmdbData && tmdbData.detailed_seasons) {
            const sNum = parseInt(match[1], 10);
            const eNum = parseInt(match[2], 10);
            const seasonData = tmdbData.detailed_seasons[sNum];
            
            if (seasonData && seasonData.episodes) {
                const epData = seasonData.episodes.find(e => e.episode_number === eNum);
                if (epData && epData.runtime) {
                    epRuntime = epData.runtime;
                } else if (tmdbData.episode_run_time && tmdbData.episode_run_time.length > 0) {
                    epRuntime = tmdbData.episode_run_time[0];
                }
            }
        }
        
        const isWatched = !!(userSeries.progress && userSeries.progress[epKey]);

        if (!isWatched) {
            userSeries.progress[epKey] = Date.now();
            userSeries.watched_count = (userSeries.watched_count || 0) + 1;
            userSeries.watched_minutes = (userSeries.watched_minutes || 0) + epRuntime;
        } else {
            delete userSeries.progress[epKey];
            userSeries.watched_count = Math.max(0, (userSeries.watched_count || 0) - 1);
            userSeries.watched_minutes = Math.max(0, (userSeries.watched_minutes || 0) - epRuntime);
        }

        await UserLibrary.setItem(String(tvId), userSeries);
        
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

async function removeSeries(tvId) {
    const confirmation = await customConfirm("Vuoi davvero eliminare questa serie e tutti i suoi progressi dalla tua libreria?");
    if (!confirmation) return;

    try {
        await UserLibrary.removeItem(String(tvId));
        await TmdbCache.removeItem(String(tvId));
        
        console.log(`[SYS] Serie ${tvId} annientata con successo.`);
        switchTab('library');
    } catch (error) {
        console.error("[CRITICO] Fallimento durante l'eliminazione:", error);
        await customAlert("Errore critico durante la rimozione dal database.");
    }
}

// ==========================================
// GESTIONE STATO E PREFERITI
// ==========================================

async function changeSeriesStatus(tvId, newStatus) {
    try {
        const userSeries = await UserLibrary.getItem(String(tvId));
        if (!userSeries) return;
        
        userSeries.status = newStatus;
        await UserLibrary.setItem(String(tvId), userSeries);
        console.log(`[SYS] Stato aggiornato per ${tvId}: ${newStatus}`);
        
        // Forza l'aggiornamento in background della Home se abbiamo messo in pausa o completato
        renderHome();
    } catch (error) {
        console.error("[CRITICO] Fallimento cambio stato:", error);
    }
}

async function toggleFavorite(tvId) {
    try {
        const userSeries = await UserLibrary.getItem(String(tvId));
        if (!userSeries) return;
        
        userSeries.is_favorite = !userSeries.is_favorite;
        await UserLibrary.setItem(String(tvId), userSeries);
        
        console.log(`[SYS] Preferito aggiornato per ${tvId}: ${userSeries.is_favorite}`);
        
        // Ricarica chirurgicamente solo la vista dettaglio per aggiornare l'icona
        openDetailView(tvId);
    } catch (error) {
        console.error("[CRITICO] Fallimento aggiornamento preferito:", error);
    }
}

// ==========================================
// CUSTOM MODALS (ALERT & CONFIRM)
// ==========================================

function customConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-confirm');
        const msgEl = document.getElementById('modal-confirm-message');
        const btnOk = document.getElementById('btn-confirm-ok');
        const btnCancel = document.getElementById('btn-confirm-cancel');

        msgEl.innerText = message;
        modal.classList.add('active');

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

function customAlert(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-confirm');
        const msgEl = document.getElementById('modal-confirm-message');
        const btnOk = document.getElementById('btn-confirm-ok');
        const btnCancel = document.getElementById('btn-confirm-cancel');

        msgEl.innerText = message;
        btnCancel.style.display = 'none';
        btnOk.innerText = 'OK';
        btnOk.className = 'btn btn-success';

        modal.classList.add('active');

        const cleanup = () => {
            modal.classList.remove('active');
            btnOk.removeEventListener('click', onOk);
            btnCancel.style.display = 'block';
            btnOk.innerText = 'Elimina';
            btnOk.className = 'btn btn-danger';
        };

        const onOk = () => { cleanup(); resolve(); };
        btnOk.addEventListener('click', onOk);
    });
}

// ==========================================
// MOTORE DI BACKUP E RIPRISTINO
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
        document.body.appendChild(downloadAnchorNode); 
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        
        await customAlert("Backup esportato con successo. Conserva questo file al sicuro.");
    } catch (error) {
        console.error("Errore durante l'esportazione:", error);
        await customAlert("Fallimento critico durante la creazione del backup.");
    }
}

async function importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const importedData = JSON.parse(e.target.result);
            if (typeof importedData !== 'object' || importedData === null) throw new Error("Formato non valido");

            for (const [key, value] of Object.entries(importedData)) {
                await UserLibrary.setItem(key, value);
            }

            await customAlert("Backup ripristinato con successo! Ricarica la pagina o il cruscotto.");
            event.target.value = ''; 
            renderLibrary(); 

        } catch (error) {
            console.error("Errore durante l'importazione:", error);
            await customAlert("Il file selezionato non è un backup valido.");
        }
    };
    
    reader.readAsText(file);
}

// ==========================================
// MOTORE UI E NAVIGAZIONE
// ==========================================

const currentTheme = localStorage.getItem('tvTheme') || 'dark';
document.documentElement.setAttribute('data-theme', currentTheme);

function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('tvTheme', newTheme);
    updateSettingsUI();
}

function switchTab(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewId}`).classList.add('active');
    
    document.querySelectorAll('.nav-links button').forEach(b => b.classList.remove('active'));
    const targetNav = document.getElementById(`nav-${viewId}`);
    if (targetNav) targetNav.classList.add('active');

    if (viewId === 'library') renderLibrary();
    if (viewId === 'home') renderHome();
    if (viewId === 'stats') renderStats();
    
    window.scrollTo(0, 0);
}

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
// EVENTI DI SISTEMA E INIZIALIZZAZIONE
// ==========================================

document.addEventListener('seasonSyncCompleted', (event) => {
    const { syncedTvId } = event.detail;
    const detailView = document.getElementById('view-detail');

    if (detailView.classList.contains('active') && window.currentOpenTvId === syncedTvId) {
        console.log(`[REATTIVITÀ] Sincronizzazione completata. Ricarico UI.`);
        openDetailView(syncedTvId);
    }
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('[SYS] Service Worker registrato con successo.', reg.scope))
            .catch(err => console.error('[CRITICO] Registrazione Service Worker fallita:', err));
    });
}

// Init
switchTab('home');