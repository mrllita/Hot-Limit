const weatherForm = document.querySelector(".weatherForm"); 
const cityInput = document.querySelector(".cityInput"); 
const card = document.querySelector(".card");

const apiKey = "5730205a531c686b5ba1f30b601dd281"; 

weatherForm.addEventListener("submit", async event => {
    event.preventDefault(); 

    const city = cityInput.value;

    if(city){

        try{
            const weatherData = await getWeatherData(city); 
            displayWeatherInfo(weatherData); 
        }
        catch(error){
            console.error(error); 
            displayError(error); 
        }
    }
    else{
        displayError("Please enter a city name.");
    }

});

async function getWeatherData(city){
    const apiUrl = https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}
    https://api.openweathermap.org/data/4.0/onecall/current?lat={lat}&lon={lon}&appid={API key}; 

    const response = await fetch(apiUrl); 

    console.log(reponse); 
}


function displayWeatherInfo(data){

}

function getWeatherEmoji(weatherId){

}

function displayError(message){
    const errorDisplay = document.createElement("p");
    errorDisplay.textContent = message; 
    //erroDisplay.classlist.add("errorDisplay");  <-- adding the formatting from CSS with .errorDisplay

    card.textContent = ""; 
    card.style.display = "flex"; 
    card.appendChild(errorDisplay); 
}
﻿
Cailyn O
nowimscared
 
 
 
 