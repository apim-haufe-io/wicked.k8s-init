FROM node:6-alpine

RUN mkdir -p /usr/src/app && chown -R node /usr/src/app
WORKDIR /usr/src/app
USER node
COPY package.json /usr/src/app
RUN npm install
COPY . /usr/src/app

CMD ["node", "index.js"]
