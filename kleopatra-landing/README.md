# Kleopátra Szalon – Landing (külön frontend)

Ez egy **teljesen különálló**, statikus marketing-landing a Kleopátra Szalon számára,
amit külön portra tudsz indítani, függetlenül a meglévő vállalatirányítási frontendtől.

## Fájlok

- `index.html` – az egyoldalas landing oldal
- `styles.css` – modern, Kleopátra-brandhez igazított dizájn
- `script.js` – mobilmenü, smooth scroll, évszám kitöltés
- `server.js` – egyszerű Express szerver (külön port)
- `package.json` – Node/Express beállítások

## Használat

1. Csomagold ki egy mappába, pl.:

   ```bash
   C:\kleoszalon\kleopatra-landing
   ```

2. Telepítsd a függőségeket:

   ```bash
   npm install
   ```

3. Indítsd el a külön frontendet **új porton** (alapból `3002`):

   ```bash
   npm start
   ```

4. Böngészőben nyisd meg:

   - [http://localhost:3002](http://localhost:3002)

Így a meglévő vállalatirányítási rendszered (pl. `3000` / `3001`) **érintetlen marad**, ez a landing külön porton fut.

Ha más portra szeretnéd:

```bash
set PORT=4000
npm start
```

vagy Linux/macOS alatt:

```bash
PORT=4000 npm start
```

Ez csak a kinézetet és a struktúrát mutatja –
a `/appointments` linkeket könnyen rá tudod kötni a meglévő API/booking rendszerre.
