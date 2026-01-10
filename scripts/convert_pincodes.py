#!/usr/bin/env python3
"""
Convert government PIN code CSV into JSON and indexes for fast client lookup.
Usage:
  python scripts/convert_pincodes.py --pincsv path/to/pincodes.csv [--bankcsv path/to/bank_serviceability.csv] --outdir mock-api

Expected pincodes CSV columns (common data.gov fields): pincode, officeName, district, state
Bank CSV (optional): pincode, bank, status (serviceable/partial/not)

Outputs:
- mock-api/pincodes.json      (array of records)
- mock-api/index.json         (object: pincode -> record)
- mock-api/bank_serviceability.json  (object: pincode -> [{bank,status}, ...])
"""
import csv
import json
import os
import argparse


def read_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return [row for row in reader]


def normalize_record(row):
    # normalize keys for expected fields
    p = row.get('pincode') or row.get('PINCODE') or row.get('Pincode') or row.get('PinCode')
    office = row.get('officeName') or row.get('OFFICENAME') or row.get('OfficeName') or row.get('office') or row.get('Office') or ''
    district = row.get('district') or row.get('DISTRICT') or row.get('District') or ''
    state = row.get('state') or row.get('STATE') or row.get('State') or ''
    return {'pincode': str(p).strip(), 'officeName': office.strip(), 'district': district.strip(), 'state': state.strip()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pincsv', required=True)
    parser.add_argument('--bankcsv', required=False)
    parser.add_argument('--outdir', default='mock-api')
    args = parser.parse_args()

    os.makedirs(args.outdir, exist_ok=True)

    print('Reading pincodes CSV from', args.pincsv)
    rows = read_csv(args.pincsv)
    records = []
    index = {}
    for r in rows:
        rec = normalize_record(r)
        if not rec['pincode']:
            continue
        records.append(rec)
        index[rec['pincode']] = rec

    pincodes_path = os.path.join(args.outdir, 'pincodes.json')
    with open(pincodes_path, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    print('Wrote', pincodes_path, '(', len(records), 'records)')

    index_path = os.path.join(args.outdir, 'index.json')
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print('Wrote', index_path)

    if args.bankcsv:
        print('Reading bank serviceability CSV from', args.bankcsv)
        bank_rows = read_csv(args.bankcsv)
        bank_map = {}
        for b in bank_rows:
            p = (b.get('pincode') or b.get('PINCODE') or b.get('Pincode') or b.get('PinCode') or '').strip()
            bank = (b.get('bank') or b.get('Bank') or b.get('BANK') or '').strip()
            status = (b.get('status') or b.get('Status') or b.get('STATUS') or '').strip()
            if not p:
                continue
            bank_map.setdefault(p, []).append({'bank': bank, 'status': status})
        bank_path = os.path.join(args.outdir, 'bank_serviceability.json')
        with open(bank_path, 'w', encoding='utf-8') as f:
            json.dump(bank_map, f, ensure_ascii=False, indent=2)
        print('Wrote', bank_path)

    print('Done.')

if __name__ == '__main__':
    main()
