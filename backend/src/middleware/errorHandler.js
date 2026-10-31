module.exports = function errorHandler(err, req, res, next) {
  if (err.status) {
    return res.status(err.status).send({ message: err.message, details: err.details });
  }
  if (err.name === "CastError") {
    return res.status(404).send({ message: "Not found" });
  }
  if (err.name === "ValidationError") {
    return res.status(400).send({ message: err.message });
  }
  if (err.code === 11000) {
    return res.status(409).send({ message: "A record with this number already exists" });
  }
  console.error(err);
  res.status(500).send({ message: "Internal Server Error" });
};
