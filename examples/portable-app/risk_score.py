def run(input, context):
    amount = float(input.get("amount", 0))
    country = str(input.get("country", "")).upper()
    score = min(100, round(amount / 100) + (30 if country not in {"US", "CA", "GB"} else 0))
    return {
        "score": score,
        "band": "high" if score >= 70 else "medium" if score >= 35 else "low",
        "appId": context["appId"],
    }
