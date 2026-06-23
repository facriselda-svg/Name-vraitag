"""
VraiTag™ — Structured AI Authentication Engine
Uses Google GenAI + Pydantic for forensic-grade structured output.
Called by server.js: python3 analyze.py <image_path>
"""

import os
import sys
import json
from typing import List, Literal
from PIL import Image
from pydantic import BaseModel, Field
from google import genai
from google.genai import types


# ─── SCHEMA ──────────────────────────────────────────────────────────────────

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


# ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────

SYSTEM_INSTRUCTION = (
    "You are a blind forensic quality control system processing a macro photograph of a luxury bag. "
    "Your response must be an objective architectural review of the typography, materials, and construction. "
    "Analyze the image based on the following strict criteria:\n"
    "1. Font Geometry: Are the counters of letters perfect circles or ellipses? Consistent weight?\n"
    "2. Kerning & Alignment: Is the spacing between letters uniform, or do specific character pairs overlap or drift?\n"
    "3. Stamp/Emboss Depth: Does the crispness of edge lines indicate heat-debossing, surface printing, or uneven pressure?\n"
    "4. Hardware & Stitching: Are stitch counts consistent? Is hardware engraving crisp with proper depth?\n"
    "You are an isolated architectural quality control inspector. "
    "Analyze strictly for typographical consistency, geometric symmetry, and material execution. "
    "Do not speculate on overall product legitimacy; provide only objective data points."
)

ANALYSIS_PROMPT = (
    "Analyze this macro photograph for manufacturing and typography metrics. "
    "Cross-examine spacing alignment, font geometry, and tool indentation depth. "
    "Identify the brand and run forensic checkpoints on every visible authentication marker."
)


# ─── MAIN ────────────────────────────────────────────────────────────────────

def analyze_image(image_path: str) -> dict:
    client = genai.Client(api_key=os.environ.get("GEMINI_KEY"))
    img = Image.open(image_path)

    response = client.models.generate_content(
        model='gemini-1.5-flash',
        contents=[img, ANALYSIS_PROMPT],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=AuthenticationAudit,
            system_instruction=SYSTEM_INSTRUCTION,
            temperature=0.1,
        ),
    )
    return json.loads(response.text)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python3 analyze.py <image_path>"}))
        sys.exit(1)

    image_path = sys.argv[1]
    if not os.path.exists(image_path):
        print(json.dumps({"error": f"File not found: {image_path}"}))
        sys.exit(1)

    try:
        result = analyze_image(image_path)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
