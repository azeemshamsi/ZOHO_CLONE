const test = require("node:test");
const assert = require("node:assert");
const { computeRateCard, chargeableWeight, slabFreight } = require("../src/utils/couriers/rates");

// Expected values produced by the original Python calculator (Maganova/BillFlow static_quote).
const CASES = [
 {
  "courier": {
   "rate_type": "slab",
   "volumetric_divisor": 5000,
   "default_zone": "A",
   "zones": [
    {
     "zone": "A",
     "slabs": [
      {
       "up_to_kg": 5,
       "price": 80
      },
      {
       "up_to_kg": 10,
       "price": 140
      }
     ],
     "additional_per_kg": 12
    },
    {
     "zone": "D",
     "slabs": [
      {
       "up_to_kg": 0.5,
       "price": 45
      },
      {
       "up_to_kg": 10,
       "price": 300
      },
      {
       "up_to_kg": 30,
       "price": 620
      }
     ],
     "additional_per_kg": 28
    }
   ],
   "extras": {
    "fuel_surcharge_pct": 12.5,
    "docket_charge": 50,
    "ecc_slabs": [
     {
      "up_to_kg": 50,
      "price": 75
     },
     {
      "up_to_kg": 100,
      "price": 150
     }
    ],
    "owsp_slabs": [
     {
      "up_to_kg": 33,
      "price": 0
     },
     {
      "up_to_kg": 70,
      "price": 250
     }
    ],
    "ecc_districts": [
     {
      "state": "Uttar Pradesh",
      "district": "Gautam Buddha Nagar (Noida)"
     }
    ],
    "ras_states": [
     "Kerala",
     "Bihar"
    ],
    "ras_per_kg": 3,
    "gst_pct": 18,
    "cod_flat": 40,
    "cod_pct": 1.5,
    "idc_pct": 2,
    "efss_pct": 1,
    "fov_pct": 0.2,
    "custom1_label": "Handling",
    "custom1_type": "pct_freight",
    "custom1_value": 5,
    "custom2_label": "Pickup",
    "custom2_type": "fixed",
    "custom2_value": 20
   }
  },
  "zone": "D",
  "w": 29.5,
  "l": 87,
  "b": 80,
  "h": 76,
  "value": 29500,
  "cod": false,
  "state": "Kerala",
  "district": "Ernakulam",
  "eccListed": false,
  "eccConf": false
 },
 {
  "same": 0,
  "zone": "D",
  "w": 3.2,
  "l": 30,
  "b": 20,
  "h": 15,
  "value": 4000,
  "cod": true,
  "state": "Uttar Pradesh",
  "district": "Noida",
  "eccListed": false,
  "eccConf": false
 },
 {
  "same": 0,
  "zone": "A",
  "w": 7,
  "l": 0,
  "b": 0,
  "h": 0,
  "value": 1000,
  "cod": true,
  "state": "Delhi",
  "district": "South Delhi",
  "eccListed": true,
  "eccConf": true
 },
 {
  "courier": {
   "rate_type": "per_kg",
   "volumetric_divisor": 4500,
   "default_zone": "Z",
   "zones": [
    {
     "zone": "Z",
     "per_kg_rate": 22
    }
   ],
   "extras": {
    "ecc_charge": 30,
    "gst_pct": 0,
    "cod_flat": 35,
    "cod_pct": 2
   }
  },
  "zone": "Z",
  "w": 0.4,
  "l": 40,
  "b": 30,
  "h": 20,
  "value": 2500,
  "cod": true,
  "state": "Bihar",
  "district": "Patna",
  "eccListed": false,
  "eccConf": false
 }
];
const EXPECTED = [
 {
  "cw": 106,
  "total": 4729.84,
  "breakdown": {
   "freight": 2748.0,
   "fuel_surcharge": 343.5,
   "docket": 50.0,
   "ecc": 0.0,
   "owsp": 250.0,
   "ras": 318.0,
   "idc": 54.96,
   "efss": 27.48,
   "fov": 59.0,
   "custom1": {
    "label": "Handling",
    "amount": 137.4
   },
   "custom2": {
    "label": "Pickup",
    "amount": 20.0
   },
   "cod_charge": 0.0,
   "gst": 721.5
  }
 },
 {
  "cw": 4,
  "total": 454.67,
  "breakdown": {
   "freight": 143.0,
   "fuel_surcharge": 17.88,
   "docket": 50.0,
   "ecc": 75.0,
   "owsp": 0.0,
   "ras": 0.0,
   "idc": 2.86,
   "efss": 1.43,
   "fov": 8.0,
   "custom1": {
    "label": "Handling",
    "amount": 7.15
   },
   "custom2": {
    "label": "Pickup",
    "amount": 20.0
   },
   "cod_charge": 60.0,
   "gst": 69.36
  }
 },
 {
  "cw": 7,
  "total": 368.54,
  "breakdown": {
   "freight": 104.0,
   "fuel_surcharge": 13.0,
   "docket": 50.0,
   "ecc": 75.0,
   "owsp": 0.0,
   "ras": 0.0,
   "idc": 2.08,
   "efss": 1.04,
   "fov": 2.0,
   "custom1": {
    "label": "Handling",
    "amount": 5.2
   },
   "custom2": {
    "label": "Pickup",
    "amount": 20.0
   },
   "cod_charge": 40.0,
   "gst": 56.22
  }
 },
 {
  "cw": 6,
  "total": 212.0,
  "breakdown": {
   "freight": 132.0,
   "fuel_surcharge": 0.0,
   "docket": 0.0,
   "ecc": 30.0,
   "owsp": 0.0,
   "ras": 0.0,
   "idc": 0.0,
   "efss": 0.0,
   "fov": 0.0,
   "custom1": null,
   "custom2": null,
   "cod_charge": 50.0,
   "gst": 0.0
  }
 }
];

test("rate card matches the Python calculator to the paisa", () => {
  let rc;
  CASES.forEach((c, i) => {
    rc = c.courier || rc;
    const cw = chargeableWeight({ weight: c.w, length: c.l, breadth: c.b, height: c.h }, rc).weight;
    assert.equal(cw, EXPECTED[i].cw, "chargeable weight " + i);
    const r = computeRateCard(rc, { zone: c.zone, cw, orderValue: c.value, isCod: c.cod, destState: c.state, destDistrict: c.district, eccListed: c.eccListed, eccListConfigured: c.eccConf });
    assert.deepStrictEqual(r.breakdown, EXPECTED[i].breakdown, "breakdown " + i);
    assert.equal(r.total, EXPECTED[i].total, "total " + i);
  });
});

test("slab freight takes the cheapest qualifying slab", () => {
  const z = { slabs: [{ up_to_kg: 5, price: 80 }, { up_to_kg: 10, price: 140 }], additional_per_kg: 30 };
  assert.equal(slabFreight(7, z, "slab"), 140); // 80 + 2×30 = 140 vs 140
  assert.equal(slabFreight(6, z, "slab"), 110);
  assert.equal(slabFreight(12, z, "slab"), 200);
});
