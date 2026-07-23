class TVTimeMigrator {
    constructor() {
        this.tmdbApi = TMDB_CONFIG.BASE_URL;
        this.apiKey = TMDB_CONFIG.API_KEY;
    }

    async processZip(file) {
        if (!window.JSZip) {
            throw new Error("Libreria JSZip mancante. Controlla index.html.");
        }

        console.log("[MIGRATOR] Apertura file ZIP in corso...");
        const zip = new JSZip();
        
        try {
            const contents = await zip.loadAsync(file);
            
            // Cerca il file dei progressi (supporta varie versioni storiche dell'export)
            const trackingFile = contents.file("tracking-prod-records-v2.csv") || contents.file("tracking-prod-records.csv");
            
            if (!trackingFile) {
                throw new Error("Il file ZIP non contiene il file tracking-prod-records.csv.");
            }

            console.log("[MIGRATOR] CSV trovato. Estrazione...");
            const csvText = await trackingFile.async("string");
            
            // FONDAMENTALE: Restituisce l'esito della migrazione verso l'esterno
            return await this.parseAndMigrate(csvText);

        } catch (e) {
            console.error(e);
            throw new Error("Impossibile leggere l'archivio ZIP. Assicurati che non sia corrotto.");
        }
    }

    async parseAndMigrate(csvText) {
        const rows = csvText.split('\n').filter(row => row.trim() !== '');
        if (rows.length < 2) throw new Error("Il CSV dei progressi è vuoto o illeggibile.");

        // 1. PULIZIA E RILEVAMENTO AUTOMATICO
        const headerRow = rows[0].replace(/^\uFEFF/, '').toLowerCase();
        const separator = (headerRow.split(';').length > headerRow.split(',').length) ? ';' : ',';

        // 2. PARSER BLINDATO
        const parseRow = (rowStr) => {
            const result = [];
            let cell = '';
            let inQuotes = false;
            for (let i = 0; i < rowStr.length; i++) {
                const c = rowStr[i];
                if (c === '"') {
                    inQuotes = !inQuotes;
                } else if (c === separator && !inQuotes) {
                    result.push(cell.trim());
                    cell = '';
                } else {
                    cell += c;
                }
            }
            result.push(cell.trim());
            return result.map(v => v.replace(/^"|"$/g, ''));
        };

        const headers = parseRow(headerRow);
        console.log("[MIGRATOR] Intestazioni rilevate:", headers);

        // 3. RICERCA PRIORITARIA DELLE COLONNE
        const getColumnIndex = (exactMatches, fallbackKeyword) => {
            for (let match of exactMatches) {
                const idx = headers.indexOf(match);
                if (idx !== -1) return idx;
            }
            return headers.findIndex(h => h.includes(fallbackKeyword));
        };

        const showNameIdx = getColumnIndex(['series_name', 'tv_show_name', 'show_name'], 'titolo');
        const seasonIdx = getColumnIndex(['season_number', 'season'], 'stagione');
        const episodeIdx = getColumnIndex(['episode_number', 'episode'], 'episodio');

        if (showNameIdx === -1 || seasonIdx === -1 || episodeIdx === -1) {
            console.error(`[MIGRATOR] Debug Indici Falliti -> Show: ${showNameIdx}, Season: ${seasonIdx}, Ep: ${episodeIdx}`);
            throw new Error("Impossibile mappare le colonne del CSV. Il formato interno di TV Time è drasticamente alterato.");
        }

        console.log(`[MIGRATOR] Inizio elaborazione logica di ${rows.length - 1} spunte...`);
        const seriesData = {};

        // 4. ASSEMBLAGGIO DEI DATI
        for (let i = 1; i < rows.length; i++) {
            const columns = parseRow(rows[i]);
            
            if (columns.length <= Math.max(showNameIdx, seasonIdx, episodeIdx)) continue;

            const showName = columns[showNameIdx];
            const season = parseInt(columns[seasonIdx], 10);
            const episode = parseInt(columns[episodeIdx], 10);

            if (!showName || isNaN(season) || isNaN(episode) || season === 0) continue;

            if (!seriesData[showName]) {
                seriesData[showName] = { episodes: [] };
            }
            seriesData[showName].episodes.push(`S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`);
        }

        const showNames = Object.keys(seriesData);
        console.log(`[MIGRATOR] Identificate ${showNames.length} serie TV uniche da interrogare su TMDB.`);

        // 5. PONTE API TMDB
        const loaderText = document.querySelector('#global-loader strong');
        let successCount = 0;
        let failCount = 0;
        let failedShows = []; // Registro dei titoli persi

        for (let i = 0; i < showNames.length; i++) {
            const originalName = showNames[i];
            const cleanName = originalName.replace(/\s*\(\d{4}\)\s*$/, '').trim();
            
            if (loaderText) {
                loaderText.innerText = `MIGRAZIONE: ${i + 1} / ${showNames.length}\n${cleanName}`;
            }

            try {
                const searchRes = await fetch(TMDB_CONFIG.buildSearchUrl(encodeURIComponent(cleanName), 'tv'));
                const searchData = await searchRes.json();

                if (!searchData.results || searchData.results.length === 0) {
                    console.warn(`[MIGRATOR] Ignorata: "${originalName}". TMDB non ha trovato corrispondenze.`);
                    failCount++;
                    failedShows.push(originalName);
                    continue;
                }

                const tmdbId = searchData.results[0].id;

                // 1. CHIAMATA DI DETTAGLIO OBBLIGATORIA (per ottenere l'array 'seasons')
                const detailRes = await fetch(`${TMDB_CONFIG.BASE_URL}/tv/${tmdbId}?api_key=${TMDB_CONFIG.API_KEY}&language=it-IT`);
                if (!detailRes.ok) {
                    console.warn(`[MIGRATOR] Impossibile scaricare i dettagli completi per ID ${tmdbId}`);
                    failCount++;
                    failedShows.push(originalName);
                    continue;
                }
                const tmdbFullData = await detailRes.json();

                // 2. MODELLO UTENTE E CACHE
                const userSeriesModel = {
                    id: tmdbId,
                    status: "watching", 
                    added_at: Date.now(),
                    watched_count: seriesData[originalName].episodes.length,
                    watched_minutes: seriesData[originalName].episodes.length * 45,
                    progress: {},
                    is_favorite: false,
                    media_type: 'tv'
                };

                seriesData[originalName].episodes.forEach(epKey => {
                    userSeriesModel.progress[epKey] = Date.now();
                });

                await UserLibrary.setItem(String(tmdbId), userSeriesModel);
                
                // Inietta il DNA strutturale completo nella cache
                tmdbFullData.media_type = 'tv';
                tmdbFullData.last_updated = Date.now();
                await TmdbCache.setItem(String(tmdbId), tmdbFullData);

                successCount++;

                // 3. INNESCO AUTOMATICO DEL DOWNLOAD STAGIONI (identico a backgroundSeasonSync)
                if (tmdbFullData.seasons && tmdbFullData.seasons.length > 0) {
                    // Sfruttiamo la funzione nativa globale definita in app.js per scaricare i dettagli delle stagioni
                    backgroundSeasonSync(tmdbId, tmdbFullData.seasons);
                }
                
                // Freno artificiale per impedire a TMDB di bloccare l'IP
                await sleep(350);

            } catch (err) {
                console.error(`[MIGRATOR] Errore di rete su ${originalName}:`, err);
                failCount++;
                failedShows.push(originalName);
            }
        }

        console.log(`[MIGRATOR] Operazione Conclusa. Titoli Trasferiti: ${successCount}. Titoli Persi: ${failCount}.`);
        
        // Esegue il check di auto-completamento su tutte le chiavi salvate dopo 4 secondi (dando tempo al background sync)
        setTimeout(async () => {
            console.log("[MIGRATOR] Esecuzione scansione post-migrazione per determinare le serie completate...");
            const keys = await UserLibrary.keys();
            for (const key of keys) {
                if (typeof checkAutoCompletion === 'function') {
                    await checkAutoCompletion(key);
                }
            }
            console.log("[MIGRATOR] Ricalcolo stati terminato.");
            silentCacheUpdate();
        }, 4000);

        return {
            successCount: successCount,
            failCount: failCount,
            failedShows: failedShows
        };
    }
}