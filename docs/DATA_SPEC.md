# Project Trace: Synthetic Data Spec
## "Uber Compliance & Audit" Dataset

**Target Volume:** 100,000 Rows
**Format:** Lance Columnar Dataset
**Theme:** Global Ride-Sharing Regulatory & Safety Compliance

### 1. The Schema Definition
The Python ingestion script (`/scripts/seed.py`) must generate a Pandas DataFrame with the following exact columns before writing to Lance:

* `incident_id` (String): A standard UUIDv4.
* `timestamp` (Datetime): Randomized dates between `2021-01-01` and `2026-04-01`.
* `city_code` (String): The jurisdiction of the record.
* `doc_type` (String): The category of the compliance document.
* `text_content` (String): The actual "messy" text that the AI will search against (200-500 words).
* `vector` (Array of Floats): A 1536-dimensional array. (Note: Generate random floats between -1.0 and 1.0 for the bulk seed).

### 2. The Data Dictionaries
**city_code:**
`["NYC-TLC", "LON-TfL", "SF-CPUC", "PAR-VTC", "CHI-BACP", "MEX-SEMOVI", "SAO-DTP"]`

**doc_type:**
`["Vehicle_Inspection_Audit", "Driver_Background_Flag", "Insurance_Lapse_Report", "City_Permit_Renewal", "Safety_Incident_Log", "Data_Privacy_Request"]`

### 3. Text Generation Templates
* **Template A (Insurance):** `"URGENT NOTIFICATION: Vehicle VIN {random_vin} operating in {city_code} detected with a lapse in commercial liability insurance. Coverage dropped by {provider} on {date}. Driver ID {random_id} has been temporarily waitlisted pending documentation upload."`
* **Template B (Regulatory):** `"Quarterly audit for {city_code} mandates a maximum vehicle age of 10 years. Audit flagged {random_number} vehicles in the active fleet exceeding this limit. Corrective action plan required by Q3 to avoid tier-2 fines."`
* **Template C (Safety):** `"Rider report filed against Driver ID {random_id} regarding an unauthorized passenger in the vehicle during an active UberX trip. Telematics indicate route deviation."`

### 4. Implementation Goal
Cursor should use `lancedb` and `pandas` to generate 100,000 variations of these templates and upload to S3 bucket `trace-vault`.