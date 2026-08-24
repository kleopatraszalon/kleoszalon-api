-- Egységes, kizárólag demo/UAT fiókokhoz használt jelszó: Teszt1234!
-- A tárolt érték bcrypt lenyomat; éles személyes fiókot ez a script nem érint.
UPDATE employees
SET password_hash='$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',updated_at=now()
WHERE lower(COALESCE(login_name,'')) IN ('recepcio1','recepcio2','kozmetikus1','kozmetikus2');

UPDATE users
SET password_hash='$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.'
WHERE lower(COALESCE(login_name,'')) IN ('szalonvezeto1','vezeto1','hr1','könyvelés');
