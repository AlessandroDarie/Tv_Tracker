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
        // Svuota i risultati precedenti e mostra caricamento
        resultsContainer.innerHTML = '<span style="color: #a1a1aa;">Ricerca in corso...</span>';

        const url = TMDB_CONFIG.buildSearchUrl(query);
        const response = await fetch(url);
        
        if (!response.ok) throw new Error("Errore durante la ricerca.");
        
        const data = await response.json();
        const results = data.results;

        // Pulizia del contenitore
        resultsContainer.innerHTML = '';

        if (results.length === 0) {
            resultsContainer.innerHTML = '<span style="color: #ef4444;">Nessun risultato trovato.</span>';
            return;
        }

        // Prendi solo i primi 5 risultati per non inondare l'interfaccia
        const topResults = results.slice(0, 5);

        topResults.forEach(series => {
            // Estrae l'anno di uscita se disponibile
            const year = series.first_air_date ? series.first_air_date.substring(0, 4) : 'N/A';
            
            const item = document.createElement('div');
            item.style = "display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; background: #18181b; border: 1px solid #3f3f46; border-radius: 4px;";
            item.innerHTML = `
                <div>
                    <strong>${series.name}</strong> <span style="color: #a1a1aa; font-size: 0.9em;">(${year})</span>
                </div>
                <button onclick="addSeriesToLibraryFromSearch(${series.id})" style="padding: 0.25rem 0.75rem; background: #4ade80; color: #064e3b; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 0.8rem;">
                    Traccia
                </button>
            `;
            resultsContainer.appendChild(item);
        });

    } catch (error) {
        console.error(error);
        resultsContainer.innerHTML = '<span style="color: #ef4444;">Errore di connessione o API.</span>';
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
    grid.innerHTML = '<span style="color: #a1a1aa; grid-column: 1 / -1;">Caricamento libreria...</span>';

    try {
        const keys = await UserLibrary.keys();
        
        if (keys.length === 0) {
            grid.innerHTML = '<span style="color: #a1a1aa; grid-column: 1 / -1; text-align: center; padding: 2rem 0;">La tua libreria è vuota. Cerca una serie per iniziare.</span>';
            return;
        }

        // Pulisce il messaggio di caricamento
        grid.innerHTML = '';

        // Estrazione e incrocio dei dati
        for (const key of keys) {
            // 1. Legge lo stato utente
            const userSeries = await UserLibrary.getItem(key);
            // 2. Legge i metadati TMDB per la UI
            const tmdbData = await TmdbCache.getItem(key);

            if (!tmdbData) {
                console.warn(`[DATI MANCANTI] Trovato ID ${key} in libreria ma assente in cache.`);
                continue; 
            }

            // Costruisce l'URL della locandina o usa un placeholder
            const posterUrl = tmdbData.poster_path 
                ? `${TMDB_CONFIG.IMAGE_BASE_URL}${tmdbData.poster_path}`
                : 'https://via.placeholder.com/500x750?text=No+Image';

            // Crea la card della serie
            const card = document.createElement('div');
            card.style = "background: #18181b; border: 1px solid #3f3f46; border-radius: 6px; overflow: hidden; cursor: pointer; transition: transform 0.2s;";
            
            // Effetto hover brutale in JS puro
            card.onmouseover = () => card.style.transform = "scale(1.02)";
            card.onmouseout = () => card.style.transform = "scale(1)";
            
            card.onclick = () => openDetailView(userSeries.id);

            card.innerHTML = `
                <img src="${posterUrl}" alt="${tmdbData.name}" style="width: 100%; aspect-ratio: 2/3; object-fit: cover; display: block; border-bottom: 1px solid #3f3f46;">
                <div style="padding: 0.75rem;">
                    <strong style="display: block; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${tmdbData.name}">${tmdbData.name}</strong>
                    <span style="display: block; color: #a1a1aa; font-size: 0.75rem; margin-top: 0.25rem;">Stato: ${userSeries.status}</span>
                </div>
            `;
            
            grid.appendChild(card);
        }

    } catch (error) {
        console.error("[CRITICO] Fallimento rendering libreria:", error);
        grid.innerHTML = '<span style="color: #ef4444; grid-column: 1 / -1;">Errore durante la lettura del database locale.</span>';
    }
}

// Gestore per tornare al cruscotto principale
function closeDetailView() {
    document.getElementById('detail-view').style.display = 'none';
    
    // Mostriamo di nuovo le sezioni principali (Libreria e Ricerca)
    document.getElementById('library-grid').parentElement.style.display = 'block';
    document.getElementById('search-input').parentElement.parentElement.style.display = 'block'; 
    
    // Forza un ri-rendering per aggiornare lo status nel caso l'utente abbia tracciato episodi
    renderLibrary();
}

// Motore di rendering degli episodi
async function openDetailView(tvId) {
    window.currentOpenTvId = String(tvId)
    // Nasconde la UI principale
    document.getElementById('library-grid').parentElement.style.display = 'none';
    document.getElementById('search-input').parentElement.parentElement.style.display = 'none';
    
    const detailView = document.getElementById('detail-view');
    const detailContent = document.getElementById('detail-content');
    
    detailView.style.display = 'block';
    detailContent.innerHTML = '<span style="color: #a1a1aa;">Estrazione dati dai silos...</span>';

    try {
        // Query parallela ai due database
        const userSeries = await UserLibrary.getItem(String(tvId));
        const tmdbData = await TmdbCache.getItem(String(tvId));

        if (!tmdbData || !userSeries) throw new Error("Dati corrotti o mancanti nel database locale.");

        let html = `<h2 style="margin-top: 0; color: #f4f4f5;">${tmdbData.name}</h2>`;
        
        // Verifica se il download in background è terminato
        if (!tmdbData.detailed_seasons || Object.keys(tmdbData.detailed_seasons).length === 0) {
            html += `<p style="color: #fbbf24; background: #451a03; padding: 1rem; border-radius: 4px;">Sincronizzazione episodi in corso... Attendi qualche secondo e riapri questa scheda.</p>`;
            detailContent.innerHTML = html;
            return;
        }

        html += `<div style="display: flex; flex-direction: column; gap: 1.5rem;">`;
        
        // Costruzione dinamica delle stagioni
        for (const [seasonNum, seasonData] of Object.entries(tmdbData.detailed_seasons)) {
            html += `<div style="background: #18181b; padding: 1.5rem; border: 1px solid #3f3f46; border-radius: 6px;">`;
            html += `<h3 style="margin-top: 0; color: #4ade80; border-bottom: 1px solid #27272a; padding-bottom: 0.5rem;">Stagione ${seasonNum}</h3>`;
            
            if (seasonData.episodes && seasonData.episodes.length > 0) {
                seasonData.episodes.forEach(ep => {
                    // La chiave di archiviazione per la mappa (Es. S01E01)
                    const epKey = `S${String(seasonNum).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`;
                    
                    // Complessità O(1): Verifichiamo all'istante se la chiave esiste nella mappa utente
                    const isWatched = userSeries.progress && userSeries.progress[epKey];
                    
                    const btnColor = isWatched ? '#10b981' : '#27272a';
                    const btnText = isWatched ? 'Visto' : 'Segna come visto';
                    const titleStyle = isWatched ? 'color: #52525b; text-decoration: line-through;' : 'color: #fafafa;';

                    html += `
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid #27272a;">
                            <span id="title-${tvId}-${epKey}" style="${titleStyle}"><span style="color: #52525b; width: 25px; display: inline-block;">${ep.episode_number}.</span> ${ep.name}</span>
                            <button id="btn-${tvId}-${epKey}" onclick="toggleEpisode(${tvId}, '${epKey}')" style="padding: 0.4rem 0.8rem; background: ${btnColor}; color: white; border: 1px solid #3f3f46; border-radius: 4px; cursor: pointer; font-size: 0.8rem; font-weight: bold;">
                                ${btnText}
                            </button>
                        </div>
                    `;
                });
            } else {
                html += `<span style="color: #a1a1aa;">Nessun episodio trovato.</span>`;
            }
            html += `</div>`;
        }
        
        html += `</div>`;
        detailContent.innerHTML = html;

    } catch (error) {
        console.error(error);
        detailContent.innerHTML = '<span style="color: #ef4444;">Errore critico nella lettura della cache. Controlla la console.</span>';
    }
}

// Funzione chirurgica per lo stato dell'episodio (Nessun ricaricamento distruttivo)
async function toggleEpisode(tvId, epKey) {
    try {
        const userSeries = await UserLibrary.getItem(String(tvId));
        if (!userSeries) return;

        if (!userSeries.progress) userSeries.progress = {};

        const isWatched = !!userSeries.progress[epKey];
        
        if (isWatched) {
            delete userSeries.progress[epKey];
            userSeries.watched_count = Math.max(0, userSeries.watched_count - 1);
        } else {
            userSeries.progress[epKey] = Date.now();
            userSeries.watched_count += 1;
        }

        // 1. Scrittura asincrona
        await UserLibrary.setItem(String(tvId), userSeries);
        
        // 2. Aggiornamento Chirurgico dell'Interfaccia (O(1) sul DOM)
        const btn = document.getElementById(`btn-${tvId}-${epKey}`);
        const titleSpan = document.getElementById(`title-${tvId}-${epKey}`);
        
        if (btn && titleSpan) {
            btn.style.background = !isWatched ? '#10b981' : '#27272a';
            btn.innerText = !isWatched ? 'Visto' : 'Segna come visto';
            titleSpan.style.color = !isWatched ? '#52525b' : '#fafafa';
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

// Inizializzazione dell'app al caricamento
renderLibrary();