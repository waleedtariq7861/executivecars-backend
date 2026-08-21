// Local, runtime-independent Pakistan-market specification catalog.  Entries
// are added only after source review; unlisted models are deliberately not
// treated as verified configurations.
const catalog = {
  version: 3,
  updatedAt: '2026-08-20',
  vehicles: [
    {
      make: 'Toyota', model: 'Corolla', generation: 'E170 Pakistan launch', years: [2014],
      provenance: { sourceType: 'official_distributor_price_list', sourceName: 'Toyota Central Motors Corolla price list (August 2014)', sourceUrl: 'https://toyota-central.com/ADMIN/Upload/TOYOTA%20PRICE%20LIST.pdf', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: 'XLi 1.3 MT', engineCapacity: 1298, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'GLi 1.3 MT', engineCapacity: 1298, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'GLi 1.3 AT', engineCapacity: 1298, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Altis 1.6 AT', engineCapacity: 1598, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Altis 1.8 MT', engineCapacity: 1798, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Altis 1.8 CVT-i', engineCapacity: 1798, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Altis Grande 1.8 MT', engineCapacity: 1798, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Altis Grande 1.8 CVT-i', engineCapacity: 1798, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
      ],
    },
    {
      make: 'Toyota', model: 'Corolla', generation: 'E170 Pakistan continuation', years: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022],
      provenance: { sourceType: 'official_parts_catalog', sourceName: 'Toyota Indus genuine-parts application catalogue', sourceUrl: 'https://direct.toyota-indus.com/spark-plug-90919-01275.html', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: '1.3 Gasoline', engineCapacity: 1298, transmissions: ['Manual', 'Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: '1.6 Gasoline', engineCapacity: 1598, transmissions: ['Manual', 'Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: '1.8 Gasoline', engineCapacity: 1798, transmissions: ['Manual', 'Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: '1.8 Grande Gasoline', engineCapacity: 1798, transmissions: ['Manual', 'Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
      ],
    },
    {
      make: 'Toyota', model: 'Yaris', generation: 'Pakistan locally assembled sedan', years: [2020, 2021, 2022],
      provenance: { sourceType: 'official_manufacturer_and_reference', sourceName: 'Indus Motor 2020 annual report and Toyota Yaris Pakistan reference', sourceUrl: 'https://toyota-indus.com/wp-content/uploads/2022/08/Final-Toyota-AR-2020.pdf', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: 'GLi MT 1.3', engineCapacity: 1329, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'GLi CVT 1.3', engineCapacity: 1329, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'ATIV MT 1.3', engineCapacity: 1329, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'ATIV CVT 1.3', engineCapacity: 1329, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'ATIV X MT 1.5', engineCapacity: 1496, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'ATIV X CVT 1.5', engineCapacity: 1496, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
      ],
    },
    {
      make: 'Honda', model: 'Civic', generation: 'Tenth generation Pakistan', years: [2016, 2017, 2018],
      provenance: { sourceType: 'official_manufacturer_and_reference', sourceName: 'Honda Atlas launch history and Pakistan Civic X reference', sourceUrl: 'https://www.honda.com.pk/corporate', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: '1.8 i-VTEC CVT', engineCapacity: 1799, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Oriel 1.8 i-VTEC CVT', engineCapacity: 1799, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Turbo 1.5 VTEC CVT', engineCapacity: 1498, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
      ],
    },
    {
      make: 'Honda', model: 'Civic', generation: 'Tenth generation Pakistan facelift', years: [2019, 2020, 2021],
      provenance: { sourceType: 'official_manufacturer_and_reference', sourceName: 'Honda Atlas launch history and Pakistan Civic X reference', sourceUrl: 'https://www.honda.com.pk/corporate', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: '1.8 i-VTEC CVT', engineCapacity: 1799, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Oriel 1.8 i-VTEC CVT', engineCapacity: 1799, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Turbo Oriel 1.5 VTEC CVT', engineCapacity: 1498, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'RS Turbo 1.5', engineCapacity: 1498, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
      ],
    },
    {
      make: 'Honda', model: 'City', generation: 'Fifth generation GM2 Pakistan', years: [2010, 2011, 2012, 2013, 2014, 2015, 2016],
      provenance: { sourceType: 'reputable_pakistan_reference', sourceName: 'PakWheels Honda City GM2 Pakistan generation reference', sourceUrl: 'https://www.pakwheels.com/new-cars/honda/city/2009-2021/', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: '1.3 i-VTEC', engineCapacity: 1339, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: '1.3 i-VTEC Prosmatec', engineCapacity: 1339, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: '1.5 i-VTEC', engineCapacity: 1497, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: '1.5 i-VTEC Prosmatec', engineCapacity: 1497, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Aspire 1.3 i-VTEC', engineCapacity: 1339, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Aspire 1.5 i-VTEC', engineCapacity: 1497, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Aspire Prosmatec 1.3 i-VTEC', engineCapacity: 1339, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Aspire Prosmatec 1.5 i-VTEC', engineCapacity: 1497, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
      ],
    },
    {
      make: 'Honda', model: 'City', generation: 'Fifth generation GM2 Pakistan facelift', years: [2017, 2018, 2019, 2020, 2021],
      provenance: { sourceType: 'official_manufacturer_and_reference', sourceName: 'Honda Atlas launch history and Pakistan City GM2 reference', sourceUrl: 'https://www.honda.com.pk/corporate', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: '1.3 i-VTEC', engineCapacity: 1339, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: '1.3 i-VTEC Prosmatec', engineCapacity: 1339, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: '1.5 i-VTEC', engineCapacity: 1497, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: '1.5 i-VTEC Prosmatec', engineCapacity: 1497, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Aspire 1.5 i-VTEC', engineCapacity: 1497, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
        { name: 'Aspire Prosmatec 1.5 i-VTEC', engineCapacity: 1497, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Sedan', assemblyTypes: ['Local'] },
      ],
    },
    {
      make: 'Suzuki', model: 'Mehran', generation: 'Second generation Euro II', years: [2013, 2014, 2015, 2016, 2017, 2018, 2019],
      provenance: { sourceType: 'reputable_pakistan_reference', sourceName: 'PakWheels Suzuki Mehran generation and specification reference', sourceUrl: 'https://www.pakwheels.com/new-cars/suzuki/mehran/', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: 'VX Euro II', engineCapacity: 800, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
        { name: 'VXR Euro II', engineCapacity: 800, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
      ],
    },
    {
      make: 'Suzuki', model: 'Cultus', generation: 'Celerio-based Cultus', years: [2021, 2022],
      provenance: { sourceType: 'official_brochure', sourceName: 'Pak Suzuki Cultus brochure', sourceUrl: 'https://suzukipakistan.com/media/Brochure%20Automobile/Cultus%20Brochure%20Apr%2022.pdf', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: 'VXR', engineCapacity: 998, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
        { name: 'VXL', engineCapacity: 998, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
        { name: 'VXL AGS', engineCapacity: 998, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
      ],
    },
    {
      make: 'Suzuki', model: 'Swift', generation: 'Fourth generation Pakistan launch', years: [2022],
      provenance: { sourceType: 'official_brochure', sourceName: 'Pak Suzuki All-New Swift brochure', sourceUrl: 'https://suzukipakistan.com/media/products/New%20Swift/Brochure/Brochure%20the%20All%20New%20Swift%2012.10.2022.pdf', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: 'GL', engineCapacity: 1197, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
        { name: 'GL CVT', engineCapacity: 1197, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
        { name: 'GLX CVT', engineCapacity: 1197, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
      ],
    },
    {
      make: 'Suzuki', model: 'Alto', generation: 'Eighth generation Pakistan Alto', years: [2021, 2022, 2023, 2024],
      provenance: { sourceType: 'official_brochure', sourceName: 'Pak Suzuki Alto brochure (2024)', sourceUrl: 'https://suzukipakistan.com/Media/Brochure%20Automobile/Alto%20Brochure%202024%2007.02.2024.pdf', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: 'VXR', engineCapacity: 658, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
        { name: 'VXR AGS', engineCapacity: 658, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
        { name: 'VXL AGS', engineCapacity: 658, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
      ],
    },
    {
      make: 'Suzuki', model: 'Wagon R', datasetModels: ['Wagon'], mlModel: 'Wagon', generation: 'Pakistan Wagon R', years: [2021, 2022, 2023],
      provenance: { sourceType: 'official_brochure', sourceName: 'Pak Suzuki Wagon R brochure (2022)', sourceUrl: 'https://suzukipakistan.com/media/brochure%20automobile/wagonr%20brochure%20apr%2022.pdf', verified: true, lastVerified: '2026-08-20' },
      variants: [
        { name: 'VXR', engineCapacity: 998, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
        { name: 'VXL', engineCapacity: 998, transmissions: ['Manual'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
        { name: 'VXL AGS', engineCapacity: 998, transmissions: ['Auto'], fuelTypes: ['Petrol'], bodyType: 'Hatchback', assemblyTypes: ['Local'] },
      ],
    },
  ],
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
const findVehicle = ({ make, model, year }) => catalog.vehicles.find(v => same(v.make, make) && same(v.model, model) && (!year || v.years.includes(Number(year))))
const specification = input => {
  const vehicle = findVehicle(input)
  if (!vehicle) return null
  const variant = vehicle.variants.find(v => same(v.name, input.variant))
  return variant ? { ...variant, make: vehicle.make, model: vehicle.model, generation: vehicle.generation, years: vehicle.years, provenance: vehicle.provenance } : null
}
const normalizeForMl = input => {
  const vehicle = findVehicle(input)
  return vehicle?.mlModel ? { ...input, model: vehicle.mlModel } : input
}
const validateConfiguration = input => {
  const vehicle = findVehicle(input)
  if (!vehicle) {
    return {} // Dataset/manual fallback: only a verified year + configuration is strict.
  }
  if (!input.variant) return { variant: 'Select a verified variant for this model year.' }
  const spec = specification(input)
  if (!spec) return { variant: 'This variant is not verified for the selected model year.' }
  const errors = {}
  if (Number(input.engineCapacity) !== spec.engineCapacity) errors.engineCapacity = `Verified ${spec.make} ${spec.model} ${spec.name} uses ${spec.engineCapacity} cc.`
  if (!spec.transmissions.some(value => same(value, input.transmission))) errors.transmission = 'Transmission is not valid for this verified configuration.'
  if (!spec.fuelTypes.some(value => same(value, input.fuelType))) errors.fuelType = 'Fuel type is not valid for this verified configuration.'
  if (!same(spec.bodyType, input.bodyType)) errors.bodyType = 'Body type is not valid for this verified configuration.'
  if (input.assemblyType && !spec.assemblyTypes.some(value => same(value, input.assemblyType))) errors.assemblyType = 'Assembly type is not valid for this verified configuration.'
  return errors
}
module.exports = { catalog, findVehicle, specification, normalizeForMl, validateConfiguration }
