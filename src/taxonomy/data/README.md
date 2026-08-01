# Category taxonomies

One YAML per category. **Data, not code** — extend these by knowing the domain,
not by knowing TypeScript.

`visualTells` is the field doing the real work. It is the difference between a
model that guesses and a model that knows where to look. Write it as directions
to a specific place in a specific kind of photo ("compare wall thickness at an
open tube end"), not as a description of the attribute.

## The deliberate gap

**`co2_incubator.yaml` does not exist, and must not be created.**

CO2 incubators are the zero-shot held-out category. Running that category with
no taxonomy file measures what `visualTells` is worth, and the gap between it
and the seeded-category average is the most decision-relevant number in the
eval:

- **Gap within 15 points** → the engine generalizes. "General consumer goods"
  is a viable product.
- **Gap larger than that** → the taxonomy files are doing the work, and this is
  a hand-curation business. Pivot to curated verticals, likely lab equipment,
  where willingness to pay is higher anyway.

Writing an incubator taxonomy to "improve the numbers" destroys the only
experiment that answers the product question.

## Split discipline

Categories 1-3 (`home_gym`, `bicycle`, `power_tool`) are the **dev split** —
iterate prompts and taxonomy against these freely.

Categories 4-6 (`sofa`, `laptop`, `co2_incubator`) are the **holdout**. Do not
look at holdout results until the final run. A human editing prompts against the
same listings overfits them just as reliably as gradient descent would, and
there is no model training anywhere in this project — the holdout is the only
protection against that.
