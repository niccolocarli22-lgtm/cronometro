# Incastri al Buio

Aiuta a finire un puzzle quando restano molti pezzi dello stesso colore (per esempio tutti neri). Usa solo la **forma** dei pezzi, letta da una scansione.

## Come si usa

1. Metti i pezzi sul vetro dello scanner con il lato nero sul vetro. Lascia almeno 5 mm tra un pezzo e l'altro e 1 cm dal bordo. Chiudi il coperchio e scansiona a 300 DPI in JPG, PNG o PDF.
2. Apri `index.html` e carica le scansioni dalla sezione **Scansioni**.
3. Apri la scansione: la vista dall'alto mostra il numero di ogni pezzo. Scrivilo a matita sul retro prima di togliere i pezzi.
4. In **Ricostruzione** c'è il prossimo incastro da provare. Rispondi *Combacia* o *Non combacia* e i suggerimenti si aggiornano.

Tutto il calcolo avviene nel browser. Le immagini non vengono caricate da nessuna parte.

## Come funziona

`solver.js` fa questi passaggi:

1. Trova i pezzi scuri sul fondo chiaro.
2. Ne estrae il contorno con precisione sotto il pixel, cercando il punto dove il passaggio da scuro a chiaro è più netto (così l'ombra sul coperchio non sposta il bordo).
3. Converte il contorno in millimetri.
4. Trova i 4 angoli: sceglie i candidati che formano il quadrilatero più vicino a un rettangolo, con i bracci allineati ai lati.
5. Classifica ogni lato come bordo dritto, maschio o femmina.
6. Confronta ogni maschio con ogni femmina: prima con un allineamento rigido ai minimi quadrati, poi con un raffinamento ICP sui candidati migliori.
7. Monta una griglia, mettendo un pezzo alla volta in ordine di sicurezza. Dove un pezzo tocca due vicini, controlla che le due posizioni previste coincidano nel punto in cui si incontrano quattro pezzi.

Le soglie sono calibrate sulle scansioni stesse: il programma stima quanto è "buono" un incastro vero nelle tue scansioni.

`synth.js` genera puzzle finti, usati per l'esempio e per i test.

## Test

```sh
node puzzle/test/run-tests.js --perscan 24 --blob 90 --cols 18 --rows 14   # precisione su 90 pezzi
node puzzle/test/run-tests.js --perscan 24 --blob 90 --cols 18 --rows 14 --variety 0.6 --perturb 0.15 --shadow 0.3 --blur 1.2 --seed 5
node puzzle/test/e2e.js /tmp/out                                            # interfaccia nel browser
```

Opzioni dei test: `--variety` (quanto sono diversi gli incastri; 1 = molto), `--perturb` (errore del contorno in mm), `--shadow` (ombra in mm), `--dpi`, `--blur`, `--faceup`.
