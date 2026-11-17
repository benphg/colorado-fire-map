# Colorado Precipitation & Wildland Fire Map

An interactive web map you host on your own computer. It shows annual precipitation across Colorado with historic wildfire perimeters on top, so you can see how rainfall relates to fire.

## Run it

You need Python 3.8 or newer. On Windows, get it from python.org; macOS and Linux usually already have it. There's nothing to pip install.

```
cd colorado-fire-precip-map
python run.py            # use "python3 run.py" on macOS/Linux if "python" isn't found
```

The first run downloads the data, which takes about 2–5 minutes. After that the server starts and prints:

```
this computer : http://localhost:8000
your network  : http://192.168.x.x:8000
```

Open either address in a browser. The second one works from other devices on the same Wi-Fi/LAN. If they can't connect, allow Python through your firewall. Press Ctrl+C to stop the server. Later runs start right away.

| Option | What it does |
|---|---|
| `--port 8080` | use a different port |
| `--host 127.0.0.1` | only this computer can open the map |
| `--start 1991 --end 2024` | change the precipitation years (default 2000–2024) |
| `--refresh` | re-download all the data |
| `--no-serve` | only build the data |

## Put it on the web (free, public address)

The project includes a GitHub Actions workflow (`.github/workflows/deploy.yml`). It downloads the data on GitHub's servers and publishes the map to GitHub Pages, so you don't need Python for this route.

1. Sign in at github.com (free account) and click **New repository**. Name it e.g. `colorado-fire-map`, set it to **Public**, and click **Create**.
2. On the new repo page click **uploading an existing file**. Drag in everything inside the unzipped `colorado-fire-precip-map` folder, including the hidden `.github` folder, then click **Commit changes**.
   - On a Mac, press Cmd+Shift+. in Finder to show the hidden `.github` folder.
   - If dragging the folder doesn't work, use **Add file → Create new file** instead. Name it `.github/workflows/deploy.yml` and paste in that file's contents.
3. Go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Go to the **Actions** tab, open **Build and publish map**, and click **Run workflow**. It takes about 5 minutes.
5. Your map is live at `https://<your-username>.github.io/colorado-fire-map/`. It rebuilds monthly to pick up new data.

## What's on the map

- **Precipitation layer**, with three views:
  - the average for the period
  - a single year, with a ▶ button that plays through the years
  - a year as % of the average, where brown is drier and blue is wetter
- **Fire perimeters**: click one for its name, year, acres, the average precipitation at that spot, and how wet or dry its fire year was. You can filter by size, and choose whether to show prescribed burns and older fires.
- **Side-panel charts**:
  - share of Colorado's land vs. share of burned acres in each precipitation zone
  - statewide precipitation and acres burned by year (click a year to jump to it)
  - correlation coefficients
- Basemaps (light gray, topo, satellite, relief, OSM), zoom/pan, a precipitation readout under the cursor, and an opacity slider.

## Data

- **Precipitation**: PRISM Climate Group, Oregon State University. Annual total precipitation, 4 km grid, from `services.nacse.org/prism/data/get/us/4km/ppt/<year>`. It's converted to inches and clipped to Colorado.
- **Fires**: NIFC *InterAgencyFirePerimeterHistory_All_Years_View*, queried for Colorado. Perimeters whose center falls outside the state are dropped, and duplicates reported by more than one agency are merged.

Notes: perimeter acres include unburned islands. Fire-year precipitation is calendar-year, so a fire in June only "saw" part of that year's precipitation. The map needs internet access for basemap tiles and the Leaflet library.
