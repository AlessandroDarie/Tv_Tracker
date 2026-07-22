class TVTimeMigrator {
    constructor() {
        this.dependenciesLoaded = false;
        this.tmdbApiKey = TMDB_CONFIG.API_KEY; 
        this.delayMs = 250; // Massimo 4 richieste al secondo per non farsi bannare
    }

    async loadDependencies() {
        if (this.dependenciesLoaded) return;
        
        console.log("[MIGRAZIONE] Iniezione librerie esterne...");
        await Promise.all([
            this.injectScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'),
            this.injectScript('https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js')
        ]);
        
        this.dependenciesLoaded = true;
        console.log("[MIGRAZIONE] Motore asincrono pronto.");
    }

    injectScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    async processZip(file) {
        await this.loadDependencies();
        
        const zip = new JSZip();
        const extracted = await zip.loadAsync(file);
        
        const showsFile = extracted.file("followed_tv_show.csv");
        const episodesFile = extracted.file("watched_on_episode.csv");

        if (!showsFile || !episodesFile) {
            throw new Error("Archivio non valido: mancano followed_tv_show.csv o watched_on_episode.csv");
        }

        console.log("[MIGRAZIONE] Estrazione file in memoria...");
        const showsCsv = await showsFile.async("string");
        const episodesCsv = await episodesFile.async("string");

        console.log("[MIGRAZIONE] Parsing CSV...");
        const parsedShows = Papa.parse(showsCsv, { header: true, skipEmptyLines: true });
        const parsedEpisodes = Papa.parse(episodesCsv, { header: true, skipEmptyLines: true });

        // FASE 1: Creazione Dizionario (Show Name -> TVDB ID)
        const showNameToTvdbId = new Map();
        parsedShows.data.forEach(row => {
            if (row.tv_show_name && row.tv_show_id) {
                showNameToTvdbId.set(row.tv_show_name.trim(), row.tv_show_id.trim());
            }
        });

        // FASE 2: Raggruppamento storico episodi per Serie
        const showToWatchedEpisodes = new Map();
        parsedEpisodes.data.forEach(row => {
            const name = row.tv_show_name ? row.tv_show_name.trim() : null;
            const s = parseInt(row.episode_season_number, 10);
            const e = parseInt(row.episode_number, 10);

            if (name && !isNaN(s) && !isNaN(e)) {
                if (!showToWatchedEpisodes.has(name)) {
                    showToWatchedEpisodes.set(name, new Set());
                }
                const epKey = `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
                showToWatchedEpisodes.get(name).add(epKey);
            }
        });

        console.log(`[MIGRAZIONE] Trovate ${showToWatchedEpisodes.size} serie con storico visualizzazioni. Avvio motore di traduzione...`);
        
        await this.translateAndImport(showNameToTvdbId, showToWatchedEpisodes);
    }

    // FASE 3: Traduzione e Iniezione nel Database Locale
    async translateAndImport(showNameToTvdbId, showToWatchedEpisodes) {
        let successCount = 0;
        let failCount = 0;

        for (const [showName, watchedSet] of showToWatchedEpisodes.entries()) {
            const tvdbId = showNameToTvdbId.get(showName);
            
            if (!tvdbId) {
                console.warn(`[MIGRAZIONE] Ignorata: "${showName}" (Nessun ID TVDB associato nel file followed_tv_show)`);
                failCount++;
                continue;
            }

            try {
                // Throttle coercitivo prima della chiamata
                await this.sleep(this.delayMs);
                
                const tmdbId = await this.fetchTmdbIdFromTvdb(tvdbId);
                
                if (tmdbId) {
                    console.log(`[MIGRAZIONE] [${showName}] TVDB:${tvdbId} -> TMDB:${tmdbId}. Importazione ${watchedSet.size} episodi in corso...`);
                    
                    // Iniezione nel sistema della PWA
                    await this.injectSeriesIntoLocalDB(String(tmdbId), Array.from(watchedSet));
                    successCount++;
                } else {
                    console.warn(`[MIGRAZIONE] Fallimento: "${showName}" (TMDB non riconosce l'ID TVDB ${tvdbId})`);
                    failCount++;
                }

            } catch (error) {
                console.error(`[MIGRAZIONE] Errore critico su "${showName}":`, error);
                failCount++;
            }
        }

        console.log(`\n======================================\n[MIGRAZIONE COMPLETATA]\nSerie importate con successo: ${successCount}\nFallimenti/Non trovate: ${failCount}\n======================================\n`);
        
        // Forza il refresh della home per mostrare i dati importati
        if (typeof renderHome === 'function') renderHome();
    }

    async fetchTmdbIdFromTvdb(tvdbId) {
        const url = `${TMDB_CONFIG.BASE_URL}/find/${tvdbId}?api_key=${this.tmdbApiKey}&external_source=tvdb_id`;
        const response = await fetch(url);
        
        if (!response.ok) return null;
        
        const data = await response.json();
        
        if (data.tv_results && data.tv_results.length > 0) {
            return data.tv_results[0].id;
        }
        return null;
    }

    // Questa funzione dialoga direttamente con localForage saltando la UI
    async injectSeriesIntoLocalDB(tmdbId, watchedEpisodesArray) {
        // Scarica i metadati di base per la libreria
        const seriesUrl = `${TMDB_CONFIG.BASE_URL}/tv/${tmdbId}?api_key=${this.tmdbApiKey}&language=it-IT`;
        const seriesRes = await fetch(seriesUrl);
        if (!seriesRes.ok) throw new Error("Recupero metadati fallito");
        const seriesData = await seriesRes.json();

        // 1. Salva in UserLibrary
        const libraryPayload = {
            id: tmdbId,
            name: seriesData.name,
            poster_path: seriesData.poster_path,
            status: seriesData.status === 'Ended' || seriesData.status === 'Canceled' ? 'completed' : 'watching',
            progress: {}, // Lo riempiamo sotto
            addedAt: Date.now(),
            lastUpdated: Date.now()
        };

        // Popola il progress con gli episodi importati
        watchedEpisodesArray.forEach(epKey => {
            libraryPayload.progress[epKey] = true;
        });

        await UserLibrary.setItem(tmdbId, libraryPayload);

        // 2. Registra la cache (vuota per le stagioni, il TTL in background farà il lavoro sporco successivamente per non bloccare l'importazione)
        const cachePayload = {
            _cachedAt: Date.now(),
            id: seriesData.id,
            name: seriesData.name,
            number_of_seasons: seriesData.number_of_seasons,
            status: seriesData.status,
            poster_path: seriesData.poster_path,
            episode_run_time: seriesData.episode_run_time,
            detailed_seasons: {} 
        };

        await TmdbCache.setItem(tmdbId, cachePayload);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}