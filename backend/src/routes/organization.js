const router = require("express").Router();
const Joi = require("joi");
const Organization = require("../models/Organization");
const { ah, validate } = require("../utils/http");

const address = Joi.object({
  street: Joi.string().allow(""),
  city: Joi.string().allow(""),
  state: Joi.string().allow(""),
  pincode: Joi.string().allow(""),
  country: Joi.string().allow(""),
});

router.get("/", ah(async (req, res) => res.send(await Organization.findById(req.org))));

router.put(
  "/",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        name: Joi.string().trim().min(2).required().label("Organization name"),
        gstin: Joi.string()
          .allow("")
          .uppercase()
          .pattern(/^[0-9]{2}[A-Z0-9]{13}$/)
          .messages({ "string.pattern.base": "GSTIN must be 15 characters" }),
        state: Joi.string().required().label("State"),
        address,
        email: Joi.string().allow(""),
        phone: Joi.string().allow(""),
        website: Joi.string().allow(""),
        invoicePrefix: Joi.string().allow("").max(10),
        paymentPrefix: Joi.string().allow("").max(10),
        quotePrefix: Joi.string().allow("").max(10),
        salesOrderPrefix: Joi.string().allow("").max(10),
        creditNotePrefix: Joi.string().allow("").max(10),
        defaultPaymentTerms: Joi.number().min(0).max(365),
        defaultNotes: Joi.string().allow(""),
        defaultTerms: Joi.string().allow(""),
      }),
      req.body
    );
    const org = await Organization.findByIdAndUpdate(req.org, data, { new: true, runValidators: true });
    res.send(org);
  })
);

module.exports = router;
