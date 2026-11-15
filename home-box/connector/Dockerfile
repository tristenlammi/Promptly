# The Promptly Home box connector on its own (next to a Home Assistant
# container). As a Home Assistant add-on, see ../addon-repo.
FROM python:3.12-alpine
RUN adduser -D -u 1000 box && mkdir /data && chown box /data
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY promptly_box.py .
USER box
VOLUME /data
CMD ["python", "-u", "promptly_box.py"]
