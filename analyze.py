"""
VraiTag™ — Comprehensive AI Authentication Engine v2
Forensic Auth + Model Identification + Timeline Decoding + Material Care

Usage:
  python3 analyze.py <image>                 -> Full audit: forensic + model ID + timeline
  python3 analyze.py <silhouette> <datecode> -> Multi-image audit (shape + date code)
  python3 analyze.py --care <image>          -> Material preservation care protocol only
"""

import os
import sys
import json
from typing import List, Optional, Literal
from PIL import Image
from pydantic import BaseModel, Field
from google import genai
from google.genai import types


# ─── SCHEMA 1: FORENSIC CHECKPOINTS (original) ───────────────────────────────

class QualityCheckpoint(BaseModel):
    checkpoint_name: str = Field(
        description="The specific visual asset being verified (e.g., Heat Stamp, Date Code, Stitching, Hardware Engraving)."
    )
    status: Literal["pass", "fail", "insufficient_data"] = Field(
        description="Objective structural status based strictly on the visible geometric properties."
    )
    analytical_notes: str = Field(
        description="Detailed forensic observations regarding typography, spacing, edge crispness, or stitch counts."
    )
    confidence_score: float = Field(
        description="Confidence rating from 0.0 (blurry/unclear) to 1.0 (crystal clear)."
    )

class AuthenticationAudit(BaseModel):
    brand_identified: str = Field(description="The apparent luxury brand based on text or pattern indicators.")
    micro_evaluations: List[QualityCheckpoint] = Field(description="List of individual forensic checkpoint reviews.")
    structural_variance_summary: str = Field(
        description="A technical summary detailing any physical variances or deviations found against standard brand profiles."
    )


# ─── SCHEMA 2: MODEL IDENTIFICATION + TIMELINE DECODING ──────────────────────

class ModelIdentification(BaseModel):
    predicted_model_name: str = Field(
        description="The catalog silhouette name based on shape, construction, and layout (e.g., Speedy, Neverfull, Birkin, Lady Dior)."
    )
    distinctive_features: List[str] = Field(
        description="Observed design elements confirming the silhouette (e.g., vachetta leather tabs, chaps shape, pocket count, hardware type)."
    )
    interior_lining_type: str = Field(
        description="The visible material, color, and textile pattern of the interior lining (e.g., red canvas striped, Alcantara, cross-grain leather)."
    )

class ChronologicalData(BaseModel):
    raw_code_string: str = Field(
        description="The exact alphanumeric string extracted verbatim from the date stamp, tag, or lining. Use 'None' if modern RFID/Microchip era."
    )
    extracted_factory_code: Optional[str] = Field(
        description="The alpha characters representing the production facility or workshop (e.g., TH, AR, SP, Square-J)."
    )
    decoded_production_year: Optional[int] = Field(
        description="The explicit 4-digit calendar year derived mathematically from the stamping rules."
    )
    decoded_production_timeframe: Optional[str] = Field(
        description="The specific production window, such as the calendar week or month sequence."
    )
    chronological_logic_match: Literal["validated", "mismatch", "not_applicable_rfid", "undetermined"] = Field(
        description="Indicates whether the calculated timeline aligns perfectly with known manufacturing history for this catalog configuration."
    )

class ComprehensiveBagAudit(BaseModel):
    brand_identity: str = Field(description="The primary luxury house identified on the assets.")
    model_analysis: ModelIdentification
    chronology_analysis: ChronologicalData
    forensic_summary: str = Field(description="A brief, objective architectural analysis summarizing model-to-code alignment.")


# ─── SCHEMA 3: MATERIAL CARE PROTOCOL ────────────────────────────────────────

class MaterialCareProtocol(BaseModel):
    identified_material_type: str = Field(
        description="The precise sub-type of material identified (e.g., Raw Vachetta, Coated Canvas, Lambskin, Caviar, Saffiano)."
    )
    current_condition_notes: str = Field(
        description="Objective assessment of visible wear, dryness, loss of structure, or surface dirt."
    )
    safe_cleaning_method: str = Field(
        description="Step-by-step instructions for lifting dirt without altering or stripping the material's finish."
    )
    hydration_conditioning: str = Field(
        description="The specific type of hydration required (e.g., wax-free cream, specialized balm, or strictly NONE if coated canvas)."
    )
    storage_shaping: str = Field(
        description="Explicit storage instructions (e.g., upright vs flat, internal stuffing requirements to maintain structural silhouette)."
    )
    critical_restoration_warnings: List[str] = Field(
        description="Material-specific red flags and irreversible mistakes to avoid (e.g., color transfer warnings, chemical restrictions)."
    )


# ─── SYSTEM PROMPTS ───────────────────────────────────────────────────────────

FORENSIC_SYSTEM = (
    "You are a blind forensic quality control system processing a macro photograph of a luxury bag. "
    "Your response must be an objective architectural review of the typography, materials, and construction. "
    "Analyze the image based on the following strict criteria:\n"
    "1. Font Geometry: Are the counters of letters perfect circles or ellipses? Consistent weight?\n"
    "2. Kerning & Alignment: Is the spacing between letters uniform, or do specific character pairs overlap or drift?\n"
    "3. Stamp/Emboss Depth: Does the crispness of edge lines indicate heat-debossing, surface printing, or uneven pressure?\n"
    "4. Hardware & Stitching: Are stitch counts consistent? Is hardware engraving crisp with proper depth?\n"
    "Analyze strictly for typographical consistency, geometric symmetry, and material execution. "
    "Do not speculate on overall product legitimacy; provide only objective data points."
)

FORENSIC_PROMPT = (
    "Analyze this macro photograph for manufacturing and typography metrics. "
    "Cross-examine spacing alignment, font geometry, and tool indentation depth. "
    "Identify the brand and run forensic checkpoints on every visible authentication marker."
)

TIMELINE_SYSTEM = (
    "You are an objective forensic inventory auditor specializing in vintage and modern luxury leather goods. "
    "Your task is to analyze design blueprints and decode production stamps character-by-character. "
    "Follow these strict chronological rules for parsing logic:\n"
    "- For early 1980s codes (3-4 digits): First 2 digits = Year, remaining digits = Month.\n"
    "- For 1990-2006 codes (2 letters + 4 digits): Digits 1 and 3 = Month, Digits 2 and 4 = Year.\n"
    "- For 2007-2021 codes (2 letters + 4 digits): Digits 1 and 3 = Production Week, Digits 2 and 4 = Year.\n"
    "- The current year is 2026. Any production year extracted beyond 2026 or any production week "
    "exceeding 53 must be explicitly marked as a 'mismatch'.\n"
    "Do not output opinions or subjective evaluations of authenticity. Populate the data fields based "
    "purely on visible visual evidence and mathematical code validation."
)

TIMELINE_PROMPT_SINGLE = (
    "Examine this image for overall silhouette structure to determine model classification. "
    "Also extract and decode any visible production timestamp or date code string. "
    "Cross-reference the physical characteristics against the decoded timeline rules."
)

TIMELINE_PROMPT_MULTI = (
    "Examine Input_Image_1 for overall silhouette structure to determine model classification. "
    "Examine Input_Image_2 to extract and decode the production timestamp stamp code string. "
    "Cross-reference the physical characteristics against the decoded timeline rules."
)

CARE_SYSTEM = (
    "You are a master leather conservator and archivist specializing in luxury handbag restoration. "
    "Your advice must be strictly tailored to the specific physics of the material identified. "
    "Adhere to these strict preservation principles:\n"
    "1. Coated Canvas (e.g., Monogram, Damier, Goyardine) is a vinyl-coated fabric. It does NOT absorb "
    "leather conditioners; applying oils will clog the texture and cause eventual cracking. Clean only with a damp cloth.\n"
    "2. Untreated Vachetta Leather is highly porous. Traditional lotions or water will stain it permanently or "
    "darken it unevenly. Advise dry erasers for scuffs and extreme caution with moisture.\n"
    "3. Sensitive Leathers (e.g., Lambskin) absorb oils and suffer from color transfer. Advise light, specialty "
    "creams and mandatory spot-testing.\n"
    "Never provide generic, one-size-fits-all leather cleaning advice. If a material cannot be identified with "
    "absolute certainty, flag it in the notes."
)

CARE_PROMPT = (
    "Examine the texture, stitching, grain pattern, and hardware points in this image. "
    "Identify the material composition and output a care plan. "
    "1. MATERIAL ID: State the exact material (e.g., Saffiano, Togo, Epsom, Lambskin, Vachetta, or Coated Canvas). "
    "2. IMMEDIATE CLEANING: Detail how to safely remove surface dirt. Be explicit about water-sensitivity. "
    "If the material is raw Vachetta, warn against liquid soaps. If it is canvas, explicitly restrict leather oils. "
    "3. HYDRATION: Recommend the correct chemistry for conditioning (e.g., pH-balanced delicate cream, natural resin "
    "balms, or zero conditioning if non-porous). "
    "4. PRESERVATION STORAGE: Specify how to retain its structural silhouette (e.g., stuff with acid-free tissue "
    "paper, avoid plastic wrap, keep out of high humidity environments). "
    "5. CRITICAL WARNINGS: List irreversible actions that will destroy this asset's resale value."
)


# ─── ANALYSIS FUNCTIONS ───────────────────────────────────────────────────────

def run_forensic_audit(client, image_path: str) -> dict:
    """Original forensic checkpoint scan — typography, hardware, stitching."""
    img = Image.open(image_path)
    response = client.models.generate_content(
        model='gemini-1.5-flash',
        contents=[img, FORENSIC_PROMPT],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=AuthenticationAudit,
            system_instruction=FORENSIC_SYSTEM,
            temperature=0.1,
        ),
    )
    return json.loads(response.text)


def run_comprehensive_audit_single(client, image_path: str) -> dict:
    """Model ID + timeline decode from a single image."""
    img = Image.open(image_path)
    response = client.models.generate_content(
        model='gemini-1.5-flash',
        contents=[img, TIMELINE_PROMPT_SINGLE],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ComprehensiveBagAudit,
            system_instruction=TIMELINE_SYSTEM,
            temperature=0.1,
        ),
    )
    return json.loads(response.text)


def run_comprehensive_audit_multi(client, silhouette_path: str, datecode_path: str) -> dict:
    """Model ID from silhouette image + timeline decode from date code macro."""
    silhouette_img = Image.open(silhouette_path)
    datecode_img = Image.open(datecode_path)
    response = client.models.generate_content(
        model='gemini-1.5-flash',
        contents=[silhouette_img, datecode_img, TIMELINE_PROMPT_MULTI],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ComprehensiveBagAudit,
            system_instruction=TIMELINE_SYSTEM,
            temperature=0.1,
        ),
    )
    return json.loads(response.text)


def run_care_protocol(client, image_path: str) -> dict:
    """Material preservation and care protocol."""
    img = Image.open(image_path)
    response = client.models.generate_content(
        model='gemini-1.5-flash',
        contents=[img, CARE_PROMPT],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=MaterialCareProtocol,
            system_instruction=CARE_SYSTEM,
            temperature=0.2,
        ),
    )
    return json.loads(response.text)


# ─── MAIN ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    args = sys.argv[1:]

    if not args:
        print(json.dumps({"error": "Usage: analyze.py <image> | analyze.py <silhouette> <datecode> | analyze.py --care <image>"}))
        sys.exit(1)

    client = genai.Client(api_key=os.environ.get("GEMINI_KEY"))

    try:
        # ── Mode: --care <image> ──────────────────────────────────────────────
        if args[0] == "--care":
            if len(args) < 2:
                print(json.dumps({"error": "Usage: analyze.py --care <image_path>"}))
                sys.exit(1)
            p = args[1]
            if not os.path.exists(p):
                print(json.dumps({"error": f"File not found: {p}"}))
                sys.exit(1)
            result = run_care_protocol(client, p)
            print(json.dumps(result))

        # ── Mode: <silhouette> <datecode> — multi-image audit ─────────────────
        elif len(args) >= 2:
            s_path, d_path = args[0], args[1]
            for p in [s_path, d_path]:
                if not os.path.exists(p):
                    print(json.dumps({"error": f"File not found: {p}"}))
                    sys.exit(1)
            result = run_comprehensive_audit_multi(client, s_path, d_path)
            print(json.dumps(result))

        # ── Mode: <image> — single-image full audit ───────────────────────────
        else:
            image_path = args[0]
            if not os.path.exists(image_path):
                print(json.dumps({"error": f"File not found: {image_path}"}))
                sys.exit(1)
            # Run forensic checkpoints AND comprehensive model/timeline audit
            forensic = run_forensic_audit(client, image_path)
            comprehensive = run_comprehensive_audit_single(client, image_path)
            # Merge into one unified response
            result = {
                **forensic,
                "model_analysis": comprehensive.get("model_analysis"),
                "chronology_analysis": comprehensive.get("chronology_analysis"),
                "comprehensive_summary": comprehensive.get("forensic_summary"),
            }
            print(json.dumps(result))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
