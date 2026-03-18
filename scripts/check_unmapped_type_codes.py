import json
import pandas as pd

# -------------------------------
# Load enriched OpenSky data
# -------------------------------
with open('scripts\\opensky_states_enriched_20260318_122308.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

# Extract all unique ICAO type codes from the states
icao_type_codes = set()
for state in data['states']:
    code = state.get('icao_type_code')
    if code and code.strip():
        icao_type_codes.add(code.strip().upper())

# Paste the TypeDesignatorIcons mapping here (from flights.js)
TypeDesignatorIcons = {
    'SHIP': ['blimp', 0.94], 
    'BALL': ['balloon', 1], 

    'A318': ['a319', 0.95], 
    'A319': ['a319', 1], 
    'A19N': ['a319', 1], 
    'A320': ['a320', 1], 
    'A20N': ['a320', 1],
    'A321': ['a321', 1], 
    'A21N': ['a321', 1], 

    'A306': ['heavy_2e', 0.93],
    'A330': ['a332', 0.98],
    'A332': ['a332', 0.99],
    'A333': ['a332', 1.00],
    'A338': ['a332', 1.00], 
    'A339': ['a332', 1.01], 
    'DC10': ['md11', 0.92],
    'MD11': ['md11', 0.96],

    'A359': ['a359', 1.00],
    'A35K': ['a359', 1.02],

    'A388': ['a380', 1],

    'B731': ['b737', 0.90], 
    'B732': ['b737', 0.92], 

    'B735': ['b737', 0.96], 
    'B733': ['b737', 0.98], 
    'B734': ['b737', 0.98], 

    'B736': ['b737', 0.96], 
    'B737': ['b737', 1.00], 
    'B738': ['b738', 1.00], 
    'B739': ['b739', 1.00], 

    'B37M': ['b737', 1.02], 
    'B38M': ['b738', 1.00], 
    'B39M': ['b739', 1.00], 
    'B3XM': ['b739', 1.01], 

    'P8': ['p8', 1.00],
    'P8 ?': ['p8', 1.00],

    'E737': ['e737', 1.00],

    'J328': ['airliner', 0.78], 
    'E170': ['airliner', 0.82], 
    'E75S/L': ['airliner', 0.82],
    'E75L': ['airliner', 0.82],
    'E75S': ['airliner', 0.82],  
    'A148': ['airliner', 0.83], 
    'RJ70': ['b707', 0.68], 
    'RJ85': ['b707', 0.68], 
    'RJ1H': ['b707', 0.68], 
    'B461': ['b707', 0.68], 
    'B462': ['b707', 0.68], 
    'B463': ['b707', 0.68], 
    'E190': ['airliner', 0.81], 
    'E195': ['airliner', 0.81], 
    'E290': ['airliner', 0.82], 
    'E295': ['airliner', 0.83], 
    'BCS1': ['airliner', 0.835], 
    'BCS3': ['airliner', 0.85], 

    'B741': ['heavy_4e', 0.96],
    'B742': ['heavy_4e', 0.96],
    'B743': ['heavy_4e', 0.96],
    'B744': ['heavy_4e', 0.96],
    'B74D': ['heavy_4e', 0.96],
    'B74S': ['heavy_4e', 0.96],
    'B74R': ['heavy_4e', 0.96],
    'BLCF': ['heavy_4e', 0.96],
    'BSCA': ['heavy_4e', 0.96], 
    'B748': ['heavy_4e', 0.98],

    'B752': ['heavy_2e', 0.9],
    'B753': ['heavy_2e', 0.9],

    'B772': ['heavy_2e', 1.00], 
    'B773': ['heavy_2e', 1.02],
    'B77L': ['heavy_2e', 1.02],
    'B77W': ['heavy_2e', 1.04],

    'B701': ['b707', 1],
    'B703': ['b707', 1],
    'K35R': ['b707', 1],
    'K35E': ['b707', 1],

    'FA20': ['jet_swept', 0.92], 
    'C680': ['jet_swept', 0.92], 
    'C68A': ['jet_swept', 0.92], 
    'YK40': ['jet_swept', 0.94], 
    'C750': ['jet_swept', 0.94], 
    'F2TH': ['jet_swept', 0.94], 
    'FA50': ['jet_swept', 0.94], 
    'CL30': ['jet_swept', 0.92], 
    'CL35': ['jet_swept', 0.92],
    'F900': ['jet_swept', 0.96], 
    'CL60': ['jet_swept', 0.96], 
    'G200': ['jet_swept', 0.92], 
    'G280': ['jet_swept', 0.92], 
    'HA4T': ['jet_swept', 0.92], 
    'FA7X': ['jet_swept', 0.96], 
    'FA8X': ['jet_swept', 0.96], 
    'GLF2': ['jet_swept', 0.96], 
    'GLF3': ['jet_swept', 0.96], 
    'GLF4': ['jet_swept', 0.96], 
    'GA5C': ['jet_swept', 0.96], 
    'GL5T': ['jet_swept', 0.98], 
    'GLF5': ['jet_swept', 0.98], 
    'GA6C': ['jet_swept', 0.98], 
    'GLEX': ['jet_swept', 1], 
    'GL6T': ['jet_swept', 1], 
    'GLF6': ['jet_swept', 1], 
    'GA7C': ['jet_swept', 1], 
    'GA8C': ['jet_swept', 1], 
    'GL7T': ['jet_swept', 1], 
    'E135': ['jet_swept', 0.92], 
    'E35L': ['jet_swept', 0.92], 
    'E145': ['jet_swept', 0.92], 
    'E45X': ['jet_swept', 0.92], 
    'E390': ['e390', 1],
    'CRJ1': ['jet_swept', 0.92], 
    'CRJ2': ['jet_swept', 0.92], 
    'F28': ['jet_swept', 0.93], 
    'CRJ7': ['jet_swept', 0.94], 
    'CRJ9': ['jet_swept', 0.96], 
    'F70': ['jet_swept', 0.97], 
    'CRJX': ['jet_swept', 0.98], 
    'F100': ['jet_swept', 1], 
    'DC91': ['jet_swept', 1],
    'DC92': ['jet_swept', 1],
    'DC93': ['jet_swept', 1],
    'DC94': ['jet_swept', 1],
    'DC95': ['jet_swept', 1],
    'MD80': ['jet_swept', 1.06], 
    'MD81': ['jet_swept', 1.06],
    'MD82': ['jet_swept', 1.06],
    'MD83': ['jet_swept', 1.06],
    'MD87': ['jet_swept', 1.06],
    'MD88': ['jet_swept', 1.06], 
    'MD90': ['jet_swept', 1.06],
    'B712': ['jet_swept', 1.06], 
    'B721': ['jet_swept', 1.10], 
    'B722': ['jet_swept', 1.10], 

    'T154': ['jet_swept', 1.12], 

    'BE40': ['jet_nonswept', 1], 
    'FA10': ['jet_nonswept', 1], 
    'C501': ['jet_nonswept', 1],
    'C510': ['jet_nonswept', 1],
    'C25A': ['jet_nonswept', 1],
    'C25B': ['jet_nonswept', 1],
    'C25C': ['jet_nonswept', 1],
    'C525': ['jet_nonswept', 1],
    'C550': ['jet_nonswept', 1],
    'C560': ['jet_nonswept', 1],
    'C56X': ['jet_nonswept', 1], 
    'LJ23': ['jet_nonswept', 1],
    'LJ24': ['jet_nonswept', 1],
    'LJ25': ['jet_nonswept', 1],
    'LJ28': ['jet_nonswept', 1],
    'LJ31': ['jet_nonswept', 1],
    'LJ35': ['jet_nonswept', 1], 
    'LR35': ['jet_nonswept', 1], 
    'LJ40': ['jet_nonswept', 1],
    'LJ45': ['jet_nonswept', 1],
    'LR45': ['jet_nonswept', 1], 
    'LJ55': ['jet_nonswept', 1],
    'LJ60': ['jet_nonswept', 1], 
    'LJ70': ['jet_nonswept', 1],
    'LJ75': ['jet_nonswept', 1],
    'LJ85': ['jet_nonswept', 1],

    'C650': ['jet_nonswept', 1.03], 
    'ASTR': ['jet_nonswept', 1.03], 
    'G150': ['jet_nonswept', 1.03], 
    'H25A': ['jet_nonswept', 1.03], 
    'H25B': ['jet_nonswept', 1.03], 
    'H25C': ['jet_nonswept', 1.03], 

    'PRM1': ['jet_nonswept', 0.96],
    'E55P': ['jet_nonswept', 0.96],
    'E50P': ['jet_nonswept', 0.96],
    'EA50': ['jet_nonswept', 0.96],
    'HDJT': ['jet_nonswept', 0.96],
    'SF50': ['jet_nonswept', 0.94],

    'C97': ['super_guppy', 1],
    'SGUP': ['super_guppy', 1],
    'A3ST': ['beluga', 1],
    'A337': ['beluga', 1.06],
    'WB57': ['wb57', 1],

    'A37': ['hi_perf', 1],
    'A700': ['hi_perf', 1],
    'LEOP': ['hi_perf', 1],
    'ME62': ['hi_perf', 1],
    'T2': ['hi_perf', 1],
    'T37': ['hi_perf', 1],
    'T38': ['t38', 1],
    'F104': ['t38', 1],
    'A10': ['a10', 1],
    'A3': ['hi_perf', 1],
    'A6': ['hi_perf', 1],
    'AJET': ['alpha_jet', 1],
    'AT3': ['hi_perf', 1],
    'CKUO': ['hi_perf', 1],
    'EUFI': ['typhoon', 1],
    'SB39': ['sb39', 1],
    'MIR2': ['mirage', 1],
    'KFIR': ['mirage', 1],
    'F1': ['hi_perf', 1],
    'F111': ['hi_perf', 1],
    'F117': ['hi_perf', 1],
    'F14': ['hi_perf', 1],
    'F15': ['md_f15', 1],
    'F16': ['hi_perf', 1],
    'F18': ['f18', 1],
    'F18H': ['f18', 1],
    'F18S': ['f18', 1],
    'F22': ['f35', 1],
    'F22A': ['f35', 1],
    'F35': ['f35', 1],
    'VF35': ['f35', 1],
    'L159': ['l159', 1],
    'L39': ['l159', 1],
    'F4': ['hi_perf', 1],
    'F5': ['f5_tiger', 1],
    'HUNT': ['hunter', 1],
    'LANC': ['lancaster', 1],
    'B17': ['lancaster', 1],
    'B29': ['lancaster', 1],
    'J8A': ['hi_perf', 1],
    'J8B': ['hi_perf', 1],
    'JH7': ['hi_perf', 1],
    'LTNG': ['hi_perf', 1],
    'M346': ['hi_perf', 1],
    'METR': ['hi_perf', 1],
    'MG19': ['hi_perf', 1],
    'MG25': ['hi_perf', 1],
    'MG29': ['hi_perf', 1],
    'MG31': ['hi_perf', 1],
    'MG44': ['hi_perf', 1],
    'MIR4': ['hi_perf', 1],
    'MT2': ['hi_perf', 1],
    'Q5': ['hi_perf', 1],
    'RFAL': ['rafale', 1],
    'S3': ['hi_perf', 1],
    'S37': ['hi_perf', 1],
    'SR71': ['hi_perf', 1],
    'SU15': ['hi_perf', 1],
    'SU24': ['hi_perf', 1],
    'SU25': ['hi_perf', 1],
    'SU27': ['hi_perf', 1],
    'T22M': ['hi_perf', 1],
    'T4': ['hi_perf', 1],
    'TOR': ['tornado', 1],
    'A4': ['md_a4', 1],
    'TU22': ['hi_perf', 1],
    'VAUT': ['hi_perf', 1],
    'Y130': ['hi_perf', 1],
    'YK28': ['hi_perf', 1],
    'BE20': ['twin_large', 0.92],
    'IL62': ['il_62', 1],

    'MRF1': ['miragef1', 0.75],
    'M326': ['m326', 1],
    'M339': ['m326', 1],
    'FOUG': ['m326', 1],
    'T33': ['m326', 1],

    'A225': ['a225', 1],
    'A124': ['b707', 1.18],

    'SLCH': ['strato', 1],
    'WHK2': ['strato', 0.9],

    'C130': ['c130', 1.07],
    'C30J': ['c130', 1.07],

    'P3': ['p3_orion', 1],

    'PARA': ['para', 1],

    'DRON': ['uav', 1],
    'Q1': ['uav', 1],
    'Q4': ['uav', 1],
    'Q9': ['uav', 1],
    'Q25': ['uav', 1],
    'HRON': ['uav', 1],

    'A400': ['a400', 1],

    'V22F': ['v22_fast', 1],
    'V22': ['v22_slow', 1],
    'B609F': ['v22_fast', 0.86],
    'B609': ['v22_slow', 0.86],
    'H64': ['apache', 1],

    'H60': ['blackhawk', 1], 
    'S92': ['blackhawk', 1], 
    'NH90': ['blackhawk', 1], 

    'AS32': ['puma', 1.03], 
    'AS3B': ['puma', 1.03], 
    'PUMA': ['puma', 1.03], 

    'TIGR': ['tiger', 1.00],
    'MI24': ['mil24', 1.00],
    'AS65': ['dauphin', 0.85],
    'S76': ['dauphin', 0.86],
    'GAZL': ['gazelle', 1.00],
    'AS50': ['gazelle', 1.00],
    'AS55': ['gazelle', 1.00],
    'ALO2': ['gazelle', 1.00],
    'ALO3': ['gazelle', 1.00],

    'R22': ['helicopter', 0.92],
    'R44': ['helicopter', 0.94],
    'R66': ['helicopter', 0.98],

    'EC55': ['s61', 0.94], 
    'A169': ['s61', 0.94], 
    'H160': ['s61', 0.95], 
    'A139': ['s61', 0.96], 
    'EC75': ['s61', 0.97], 
    'A189': ['s61', 0.98], 
    'A149': ['s61', 0.98], 
    'S61': ['s61', 0.98], 
    'S61R': ['s61', 1], 
    'EC25': ['s61', 1.01], 
    'EH10': ['s61', 1.04], 
    'H53': ['s61', 1.1], 
    'H53S': ['s61', 1.1], 

    'U2': ['u2', 1],
    'C2': ['c2', 1],
    'E2': ['c2', 1],
    'H47': ['chinook', 1],
    'H46': ['chinook', 1],
    'HAWK': ['bae_hawk', 1],

    'GYRO': ['gyrocopter', 1],
    'DLTA': ['verhees', 1],

    'B1': ['b1b_lancer', 1.0],
    'B52': ['b52', 1],
    'C17': ['c17', 1.25],
    'C5M': ['c5', 1.18],
    'E3TF': ['e3awacs', 0.88],
    'E3CF': ['e3awacs', 0.88],
    
    'GLID': ['glider', 1],
    
    'S6': ['glider', 1],
    'S10S': ['glider', 1],
    'S12': ['glider', 1],
    'S12S': ['glider', 1],
    
    'ARCE': ['glider', 1],
    'ARCP': ['glider', 1],
    'DISC': ['glider', 1],
    'DUOD': ['glider', 1],
    'JANU': ['glider', 1],
    'NIMB': ['glider', 1],
    'QINT': ['glider', 1],
    'VENT': ['glider', 1],
    'VNTE': ['glider', 1],
    
    'A20J': ['glider', 1],
    'A32E': ['glider', 1],
    'A32P': ['glider', 1],
    'A33E': ['glider', 1],
    'A33P': ['glider', 1],
    'A34E': ['glider', 1],
    'AS14': ['glider', 1],
    'AS16': ['glider', 1],
    'AS20': ['glider', 1],
    'AS21': ['glider', 1],
    'AS22': ['glider', 1],
    'AS24': ['glider', 1],
    'AS25': ['glider', 1],
    'AS26': ['glider', 1],
    'AS28': ['glider', 1],
    'AS29': ['glider', 1],
    'AS30': ['glider', 1],
    'AS31': ['glider', 1],
    
    'DG80': ['glider', 1],
    'DG1T': ['glider', 1],
    'LS10': ['glider', 1],
    'LS9': ['glider', 1],
    'LS8': ['glider', 1],
    
    'TS1J': ['glider', 1],
    
    'PK20': ['glider', 1],
    
    'LK17': ['glider', 1],
    'LK19': ['glider', 1],
    'LK20': ['glider', 1],

    'SR20': ['cirrus_sr22', 1],
    'SR22': ['cirrus_sr22', 1],
    'S22T': ['cirrus_sr22', 1],
    'VEZE': ['rutan_veze', 1],
    'VELO': ['rutan_veze', 1.04],

    'PRTS': ['rutan_veze', 1.3], 

    'PA24': ['pa24', 1],

    'GND': ['ground_unknown', 1],
    'GRND': ['ground_unknown', 1],
    'SERV': ['ground_service', 1],
    'EMER': ['ground_emergency', 1],
    'TWR': ['ground_tower', 1],
}

# Find unmapped  codes
unmapped_codes = sorted([code for code in icao_type_codes if code not in TypeDesignatorIcons])

print('unmapped_codes  ICAO type codes:')
for code in unmapped_codes:
    print(code)
print(f'\nTotal unmapped_codes : {len(unmapped_codes)}')

# Load aircraft database
aircraft_db = pd.read_csv(
    "scripts\\aircraft-database-complete-2025-08.csv",
    on_bad_lines='skip',
    quotechar="'",
    encoding='utf-8',
    low_memory=False
)
aircraft_db['typecode'] = aircraft_db['typecode'].str.upper()

# Print info for unmapped_codes  codes
for code in unmapped_codes:
    row = aircraft_db[aircraft_db['typecode'] == code]
    if not row.empty:
        info = row.iloc[0]
        manufacturer = info.get('manufacturerName') if pd.notna(info.get('manufacturerName')) else 'Unknown'
        model = info.get('model') if pd.notna(info.get('model')) else 'Unknown'
        category = info.get('categoryDescription') if pd.notna(info.get('categoryDescription')) else 'Unknown'
        print(f"{code}: {manufacturer} {model} ({category})")
    else:
        print(f"{code}: NOT FOUND")

# Function to suggest tar1090-style category
def suggest_icon_category(manufacturer, model):
    m = model.lower() if model else ""
    manu = manufacturer.lower() if manufacturer else ""
    # Helicopters
    if 'helicopter' in manu or 'helicopter' in m or any(h in m for h in ['bell', 'airbus helicopters', 'sikorsky', 'ec']): 
        return 'helicopter'
    # Gliders
    if 'glider' in manu or 'glider' in m or 'sailplane' in m:
        return 'glider'
    # Balloons
    if 'balloon' in m:
        return 'balloon'
    # Jets (private/business)
    if any(j in m for j in ['gulfstream','falcon','lear','jet','challenger','global']):
        return 'jet_swept'
    # High-performance / military
    if any(f in m for f in ['f16','f18','f22','f35','su27','su25','su24','kfir','mig','mirage']):
        return 'hi_perf'
    # Airliners / large commercial jets
    if any(c in m for c in ['airbus','boeing','embraer','bombardier','mcdonnell','comac','il76','tu204','tu214']):
        # Decide heavy or airliner based on model size heuristics
        if any(l in m for l in ['747','777','380','767','il76']):
            return 'heavy_2e'
        elif any(l in m for l in ['777','380','747-8']):
            return 'heavy_4e'
        else:
            return 'airliner'
    # Twin turboprops or regional
    if any(t in m for t in ['dh8','beech 1900','atr','embraer erj','embraer e']):
        return 'twin_large'
    # Single turboprops
    if any(t in m for t in ['pc-12','piper pa-46','piaggio p-180']):
        return 'single_turbo'
    # Small GA (Cessna, Piper, Beechcraft)
    if any(g in m for g in ['cessna','piper','beech','mooney','rv','diamond','cirrus']):
        return 'cessna'
    # Unknown / fallback
    return 'unknown'

# Generate suggestions
suggestions = {}
for code in unmapped_codes:
    row = aircraft_db[aircraft_db['typecode'] == code]
    if not row.empty:
        info = row.iloc[0]
        manufacturer = info.get('manufacturerName', '')
        model = info.get('model', '')
        # Handle missing or NaN values safely
        if pd.isna(manufacturer):
            manufacturer = ''
        if pd.isna(model):
            model = ''
        manufacturer = str(manufacturer).strip()
        model = str(model).strip()
        icon_category = suggest_icon_category(manufacturer, model)
        suggestions[code] = [icon_category, 1.0]  # default scale
    else:
        # If no database info, mark as unknown
        suggestions[code] = ['unknown', 1.0]

# Print suggestions
print("Auto-generated TypeDesignatorIcons suggestions:")
for code, val in suggestions.items():
    row = aircraft_db[aircraft_db['typecode'] == code]
    if not row.empty:
        manufacturer = row.iloc[0].get('manufacturerName', '')
        model = row.iloc[0].get('model', '')
        if pd.isna(manufacturer):
            manufacturer = ''
        if pd.isna(model):
            model = ''
        manufacturer = str(manufacturer).strip()
        model = str(model).strip()
        print(f"'{code}': {val},  # {manufacturer} {model}")
    else:
        print(f"'{code}': {val},  # NOT FOUND")

import requests
import re

# -------------------------------
# Fetch tar1090 markers.js
# -------------------------------
url = "https://raw.githubusercontent.com/wiedehopf/tar1090/refs/heads/master/html/markers.js"
response = requests.get(url)
if response.status_code == 200:
    js_content = response.text
    # Extract the markers object
    markers_match = re.search(r'var markers\s*=\s*({.*?});', js_content, re.DOTALL)
    if markers_match:
        markers_js = markers_match.group(1)
        # Convert JS object to Python dict (handle single quotes, trailing commas)
        markers_js = re.sub(r'(\w+):', r'"\1":', markers_js)  # keys to strings
        markers_js = markers_js.replace("'", '"')  # single to double quotes
        markers_js = re.sub(r',\s*}', '}', markers_js)  # remove trailing commas
        import json
        try:
            markers_dict = json.loads(markers_js)
        except json.JSONDecodeError as e:
            print("Failed to parse markers.js:", e)
            markers_dict = {}
    else:
        print("No markers object found in markers.js")
        markers_dict = {}
else:
    print("Failed to fetch markers.js:", response.status_code)
    markers_dict = {}

# -------------------------------
# Add any missing codes from tar1090
# -------------------------------
added_count = 0
for code in unmapped_codes:
    if code not in TypeDesignatorIcons and code in markers_dict:
        value = markers_dict[code]
        if isinstance(value, str):
            # tar1090 has format: 'C172': 'cessna' (just category)
            TypeDesignatorIcons[code] = [value, 1.0]
            added_count += 1
        elif isinstance(value, list) and len(value) >= 2:
            TypeDesignatorIcons[code] = value[:2]
            added_count += 1

print(f"Added {added_count} codes from tar1090 markers.js")

def categorize_by_model(manufacturer, model):
    text = f"{manufacturer} {model}".lower()

    # Helicopters
    if re.search(r'\b(heli|bell|sikorsky|airbus helicopters|mi|h[0-9]{1,2})\b', text):
        return 'helicopter'

    # Gliders
    if 'glider' in text or 'sailplane' in text:
        return 'glider'

    # Balloon
    if 'balloon' in text:
        return 'balloon'

    # Jets — heavies / airliners
    if any(x in text for x in ['airbus a', 'boeing ', 'embraer', 'bombardier ', 'comac', 'tu-', 'il-']):
        # heavy dual‑engine
        if any(x in text for x in ['747','777','il‑76','a380','a340','a330']):
            return 'heavy_2e'
        return 'airliner'

    # Business jets
    if any(x in text for x in ['gulfstream', 'falcon', 'learjet', 'challenger']):
        return 'jet_swept'

    # Turboprops
    if 'turboprop' in text or any(x in text for x in ['at-', 'beech 1900', 'dhc-', 'de havilland']):
        return 'twin_large'

    # Single turboprops
    if any(x in text for x in ['pc-12', 'pilatus pc-12', 'piaggio p-180']):
        return 'single_turbo'

    # GA prop
    if any(x in text for x in ['cessna', 'piper', 'beech', 'mooney', 'rv', 'diamond', 'cirrus']):
        return 'cessna'

    return 'unknown'

suggestions = {}

for code in unmapped_codes:
    row = aircraft_db[aircraft_db['typecode'] == code]
    if not row.empty:
        info = row.iloc[0]
        man = str(info.get('manufacturerName','')).strip()
        mod = str(info.get('model','')).strip()
        category = categorize_by_model(man, mod)
        suggestions[code] = [category, 1.0]
    else:
        suggestions[code] = ['unknown', 1.0]

# -------------------------------
# Print ready to paste into JS
# -------------------------------
print("\n\n// SUGGESTED TypeDesignatorIcons entries (paste into flights.js)\n")
print("{")
for code, val in suggestions.items():
    comment = aircraft_db[aircraft_db['typecode']==code][['manufacturerName','model']].agg(' '.join, axis=1).values
    comment = comment[0] if len(comment)>0 else "NOT FOUND"
    print(f"  '{code}': {val},  // {comment}")
print("}")

# (Optional) save to JSON
with open("typecode_suggestions.json","w") as f:
    json.dump(suggestions, f, indent=2)