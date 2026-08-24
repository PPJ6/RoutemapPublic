import pandas as pd

# Load files
routes = pd.read_csv("routes.csv", dtype=str)
airports = pd.read_csv("airports.csv", dtype=str)

# Normalize IATA codes
routes["origin_iata"] = routes["origin_iata"].str.strip().str.upper()
routes["dest_iata"] = routes["dest_iata"].str.strip().str.upper()
airports["iata"] = airports["iata"].str.strip().str.upper()

# Convert coordinates to numbers
airports["lat"] = pd.to_numeric(airports["lat"], errors="coerce")
airports["lon"] = pd.to_numeric(airports["lon"], errors="coerce")

# Optional but recommended: make sure each IATA code appears only once
duplicate_airports = airports[airports.duplicated("iata", keep=False)]

if not duplicate_airports.empty:
    raise ValueError(
        "Duplicate IATA codes found in airports.csv:\n"
        + duplicate_airports[["iata", "name", "city", "country"]].to_string(index=False)
    )

# Create origin airport lookup table
origin_airports = airports.rename(columns={
    "iata": "origin_iata",
    "name": "origin_name",
    "city": "origin_city",
    "state": "origin_state",
    "country": "origin_country",
    "lat": "origin_lat",
    "lon": "origin_lon"
})

# Create destination airport lookup table
dest_airports = airports.rename(columns={
    "iata": "dest_iata",
    "name": "dest_name",
    "city": "dest_city",
    "state": "dest_state",
    "country": "dest_country",
    "lat": "dest_lat",
    "lon": "dest_lon"
})

# Join routes to origin airport data
joined = routes.merge(
    origin_airports,
    on="origin_iata",
    how="left",
    validate="many_to_one"
)

# Join routes to destination airport data
joined = joined.merge(
    dest_airports,
    on="dest_iata",
    how="left",
    validate="many_to_one"
)

# Check for missing airport matches
missing_origins = joined[joined["origin_lat"].isna()]["origin_iata"].dropna().unique()
missing_dests = joined[joined["dest_lat"].isna()]["dest_iata"].dropna().unique()

if len(missing_origins) > 0 or len(missing_dests) > 0:
    message = []

    if len(missing_origins) > 0:
        message.append("Missing origin airports: " + ", ".join(sorted(missing_origins)))

    if len(missing_dests) > 0:
        message.append("Missing destination airports: " + ", ".join(sorted(missing_dests)))

    raise ValueError("\n".join(message))

# Save joined data
joined.to_csv("routes_joined.csv", index=False)
joined.to_json("routes.json", orient="records", indent=2)

print(f"Created routes_joined.csv and routes.json with {len(joined)} routes.")
