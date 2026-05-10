# Sample IIT-JEE problems for manual smoke testing

These are pasted into the UI's textarea or hit via curl against `POST /api/solve`.

## 1. Algebra — powers of roots

> If α and β are roots of x² − 6x + 1 = 0, find the value of α⁷ + β⁷.

Expected (verifiable): use Newton's identity Sₙ = 6·Sₙ₋₁ − Sₙ₋₂ with S₀ = 2, S₁ = 6 → S₇ = 1416 762.

## 2. Calculus — limit using Taylor

> Evaluate lim_{x→0} (sin x − x cos x) / x³.

Expected: 1/3.

## 3. Definite integral (classic JEE)

> Evaluate ∫₀^{π/2} ln(sin x) dx.

Expected: −(π/2) ln 2.

## 4. Conditional probability

> A bag has 4 red and 6 white balls. 3 balls are drawn at random. Find the
> probability that exactly 2 are red GIVEN that at least one is red.

Expected: P(exactly 2 red) / P(at least one red) = (36/120) / (96/120) = 3/8.

## 5. Area between curves

> Find the area enclosed between the curves y = x² and y = 2x − x².

Expected: 1/3 sq units.

---

## curl smoke test

```bash
curl -N -X POST http://127.0.0.1:8000/api/solve \
  -H "content-type: application/json" \
  -d '{"question":"Evaluate lim_{x->0} (sin x - x cos x)/x^3."}'
```

## reference questions 
https://questions.examside.com/past-years/jee/question/pif-veca-and-vecb-are-two-vectors-such-that-v-jee-main-mathematics-qzeb6i8bkswi0lwy

https://www.askiitians.com/iit-jee-2009-solutions/iit-jee-2009-mathematics-paper2-solutions-page4.aspx


You should see Server-Sent Events of types `log`, `stage`, `result`, `done`.
